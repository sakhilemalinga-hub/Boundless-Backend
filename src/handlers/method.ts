import { Request, Response } from 'express';
import { inspection_types } from '../constants/inspection_items';
import nodemailer from 'nodemailer';
import {
    getDocument,
    queryDocumentsByFilters,
    setDocument,
    updateDocument,
    createDocRef,
    getDocRef,
    runDbTransaction,
    deleteDocument,
    createUser,
    getAssignedTask
} from '../helpers/api';
import { IGetUserAuthInfoRequest, VehicleStatus } from '../dtos/types';
import fs from 'fs';
import path from 'path';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { storage } from '../config/firebase';

type Role = 'driver' | 'ops' | 'owner' | 'tour_manager';

type InspectionResult = {
    key: string;
    value: boolean | number | string;
    imageUrl?: string;
};

const allowedTourStatuses = ['planned', 'active', 'completed', 'cancelled', 'confirmed'];

export const ensureUser = (req: Request, res: Response) => {
    const user = (req as IGetUserAuthInfoRequest).user;
    if (!user?.username || !user?.role || !user?.organisationId) {
        res.status(401).json({ message: 'Unauthorized: missing user context', status: 0, data: null });
        return null;
    }
    return { uid: user.username, role: user.role, organisationId: user.organisationId, username: user.username };
};

const requireRole = (res: Response, role: Role, allowed: Role[]) => {
    if (!allowed.includes(role)) {
        res.status(403).json({ message: 'Forbidden: insufficient role', status: 0, data: null });
        return false;
    }
    return true;
};

export const getInspectionItems = async (req: Request, res: Response): Promise<Response | void> => {
    const type = req.query.type as string;
    try {
        if (!type) {
            return res.status(200).json(inspection_types);
        }
        const items = inspection_types.find((item) => item.type === type);
        res.status(200).json(items);
    } catch (error) {
        res.status(500).json({ message: 'Something went wrong', status: 0, data: null });
    }
};
export const getTaskAssigned = async (req: Request, res: Response): Promise<Response | void> => {
    const user = ensureUser(req, res);
    if (!user) return;
    try {
        const response = await getAssignedTask(user?.uid);
        res.status(200).json({ message: 'successfull fetched driver task', status: 0, data: response });
    } catch (error) {
        res.status(500).json({ message: 'Something went wrong', status: 0, data: null });
    }
};
// Tours
export const createTour = async (req: Request, res: Response): Promise<Response | void> => {
    const user = ensureUser(req, res);
    if (!user) return;
    if (!requireRole(res, user.role, ['ops', 'owner', 'tour_manager'])) return;

    const {
        driverId,
        vehicleId,
        startDate,
        endDate,
        status,
        notes,
        tour_reference,
        tour_name,
        supplier,
        pax,
        estimated_km,
        trailer_required,
        itinerary,
        instructions
    } = req.body;

    if (!startDate || !endDate) {
        return res.status(400).json({ message: 'Missing required fields: startDate and endDate', status: 0, data: null });
    }

    const tourStatus = pax > 7 ? 'confirmed' : 'planned';
    if (!allowedTourStatuses.includes(tourStatus)) {
        return res.status(400).json({ message: 'Invalid tour status', status: 0, data: null });
    }

    let vehicle = null;
    if (vehicleId) {
        vehicle = await getDocument('vehicles', vehicleId);
        if (!vehicle) {
            return res.status(404).json({ message: 'Vehicle not found', status: 0, data: null });
        }
        if (vehicle.organisationId !== user.organisationId) {
            return res.status(403).json({ message: 'Vehicle does not belong to organisation', status: 0, data: null });
        }
        if (vehicle.status !== VehicleStatus.READY) {
            return res.status(400).json({ message: 'Vehicle is not ready for assignment', status: 0, data: null });
        }
    }

    const tourRef = createDocRef('tours');
    const now = new Date().toISOString();

    await setDocument('tours', tourRef.id, {
        organisationId: user.organisationId,
        driverId: driverId || null,
        vehicleId: vehicleId || null,
        startDate,
        endDate,
        status: tourStatus,
        createdBy: user.uid,
        createdAt: now,
        updatedAt: now,
        tourId: tourRef.id,
        notes: notes ?? '',
        tour_reference: tour_reference || '',
        tour_name: tour_name || '',
        supplier: supplier || '',
        pax: pax || null,
        estimated_km: estimated_km || 0,
        trailer_required: trailer_required || false,
        itinerary: itinerary || '',
        instructions: instructions || ''
    });

    // Update vehicle with assignment details only if vehicleId is provided
    if (vehicleId && vehicle) {
        const driver = driverId ? await getDocument('users', driverId) : null;
        const vehicleStatus = VehicleStatus.READY;
        await updateDocument('vehicles', vehicleId, {
            currentDriverId: driverId || null,
            currentDriverName: driver ? driver.username : driverId || null,
            assignedById: user.uid,
            assignedByName: user.username || user.uid,
            status: vehicleStatus,
            updatedAt: now
        });
    }

    // Send email notifications if tour has assignments
    if ((vehicleId || driverId) && new Date(startDate) > new Date()) {
        // Notify tour managers
        const tourManagers = await queryDocumentsByFilters('users', [
            { field: 'organisationId', op: '==', value: user.organisationId },
            { field: 'role', op: '==', value: 'tour_manager' }
        ]);
        const managerEmails = tourManagers.filter((u: any) => u.email).map((u: any) => u.email);
        
        // Build assignment details
        let assignmentDetails = '';
        let assignedVehicle = null;
        let assignedDriver = null;
        
        if (vehicleId) {
            assignedVehicle = await getDocument('vehicles', vehicleId);
            assignmentDetails += `Vehicle: ${assignedVehicle?.licenceNumber || vehicleId}\n`;
        }
        if (driverId) {
            assignedDriver = await getDocument('users', driverId);
            assignmentDetails += `Driver: ${assignedDriver?.username || driverId}\n`;
        }

        if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
            const transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: {
                    user: process.env.EMAIL_USER,
                    pass: process.env.EMAIL_PASS
                }
            });

            // Send to tour managers
            if (managerEmails.length > 0) {
                const managerMailOptions = {
                    from: process.env.EMAIL_USER,
                    to: managerEmails.join(','),
                    subject: `New Tour Assignment: ${tour_reference}`,
                    text: `A new tour has been created with assignments:\n\nTour: ${tour_name} (${tour_reference})\nSupplier: ${supplier}\nStart Date: ${new Date(startDate).toLocaleDateString()}\nEnd Date: ${new Date(endDate).toLocaleDateString()}\nPAX: ${pax || 'N/A'}\n\nAssignments:\n${assignmentDetails}\n\nCreated by: ${user.username}`
                };
                
                try {
                    await transporter.sendMail(managerMailOptions);
                    console.log('Email notification sent to tour managers:', managerEmails.join(', '));
                } catch (error) {
                    console.error('Error sending email to tour managers:', error);
                }
            }

            // Send to assigned driver
            if (driverId && assignedDriver?.email) {
                const driverMailOptions = {
                    from: process.env.EMAIL_USER,
                    to: assignedDriver.email,
                    subject: `New Tour Assignment: ${tour_reference}`,
                    text: `You have been assigned to a new tour:\n\nTour: ${tour_name} (${tour_reference})\nSupplier: ${supplier}\nStart Date: ${new Date(startDate).toLocaleDateString()}\nEnd Date: ${new Date(endDate).toLocaleDateString()}\nPAX: ${pax || 'N/A'}\n${vehicleId && assignedVehicle ? `\nVehicle: ${assignedVehicle.licenceNumber}` : ''}\n\nPlease review the tour details in the app.\n\nAssigned by: ${user.username}`
                };
                
                try {
                    await transporter.sendMail(driverMailOptions);
                    console.log('Email notification sent to driver:', assignedDriver.email);
                } catch (error) {
                    console.error('Error sending email to driver:', error);
                }
            }
        }
    }

    res.status(201).json({ message: 'Tour created', status: 1, data: { id: tourRef.id } });
};

export const updateTour = async (req: Request, res: Response): Promise<Response | void> => {
    const user = ensureUser(req, res);
    if (!user) return;
    if (!requireRole(res, user.role, ['ops', 'owner', 'tour_manager'])) return;

    const tourId = req.params.id;
    const {
        driverId,
        vehicleId,
        startDate,
        endDate,
        status,
        notes,
        tour_reference,
        tour_name,
        supplier,
        pax,
        estimated_km,
        trailer_required,
        itinerary,
        instructions
    } = req.body;

    const tour = await getDocument('tours', tourId);
    if (!tour) {
        return res.status(404).json({ message: 'Tour not found', status: 0, data: null });
    }
    if (tour.organisationId !== user.organisationId) {
        return res.status(403).json({ message: 'Tour does not belong to organisation', status: 0, data: null });
    }

    const oldVehicleId = tour.vehicleId;
    const oldDriverId = tour.driverId;

    const updates: Record<string, any> = {};
    if (driverId !== undefined) updates.driverId = driverId;
    if (startDate) updates.startDate = startDate;
    if (endDate) updates.endDate = endDate;
    if (status) {
        if (!allowedTourStatuses.includes(status)) {
            return res.status(400).json({ message: 'Invalid tour status', status: 0, data: null });
        }
        updates.status = status;
    }
    if (vehicleId !== undefined) {
        if (vehicleId) {
            const vehicle = await getDocument('vehicles', vehicleId);
            if (!vehicle) {
                return res.status(404).json({ message: 'Vehicle not found', status: 0, data: null });
            }
            if (vehicle.organisationId !== user.organisationId) {
                return res.status(403).json({ message: 'Vehicle does not belong to organisation', status: 0, data: null });
            }
            if (vehicle.status === VehicleStatus.MAINTENANCE_REQUIRED || vehicle.status === VehicleStatus.OUT_OF_SERVICE) {
                return res.status(400).json({ message: 'Vehicle is not available for assignment', status: 0, data: null });
            }
        }
        updates.vehicleId = vehicleId;
    }
    if (notes !== undefined) updates.notes = notes;
    if (tour_reference !== undefined) updates.tour_reference = tour_reference;
    if (tour_name !== undefined) updates.tour_name = tour_name;
    if (supplier !== undefined) updates.supplier = supplier;
    if (pax !== undefined) updates.pax = pax;
    if (estimated_km !== undefined) updates.estimated_km = estimated_km;
    if (trailer_required !== undefined) updates.trailer_required = trailer_required;
    if (itinerary !== undefined) updates.itinerary = itinerary;
    if (instructions !== undefined) updates.instructions = instructions;

    if (Object.keys(updates).length === 0) {
        return res.status(400).json({ message: 'No updates provided', status: 0, data: null });
    }

    updates.updatedAt = new Date().toISOString();
    await updateDocument('tours', tourId, updates);

    // Send email notifications if vehicle or driver assignment changed for future tour
    const assignmentChanged = (vehicleId !== undefined && vehicleId !== oldVehicleId) || 
                              (driverId !== undefined && driverId !== oldDriverId);
    
    if (assignmentChanged && new Date(tour.startDate) > new Date()) {
        // Get tour managers to notify
        const tourManagers = await queryDocumentsByFilters('users', [
            { field: 'organisationId', op: '==', value: user.organisationId },
            { field: 'role', op: '==', value: 'tour_manager' }
        ]);
        const managerEmails = tourManagers.filter((u: any) => u.email).map((u: any) => u.email);
        
        if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
            const transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: {
                    user: process.env.EMAIL_USER,
                    pass: process.env.EMAIL_PASS
                }
            });

            // Build notification message
            let changeDetails = '';
            let oldVehicle = null;
            let newVehicle = null;
            let oldDriver = null;
            let newDriver = null;
            
            if (vehicleId !== undefined && vehicleId !== oldVehicleId) {
                oldVehicle = oldVehicleId ? await getDocument('vehicles', oldVehicleId) : null;
                newVehicle = vehicleId ? await getDocument('vehicles', vehicleId) : null;
                changeDetails += `Vehicle: ${oldVehicle?.licenceNumber || 'Unassigned'} → ${newVehicle?.licenceNumber || 'Unassigned'}\n`;
            }
            if (driverId !== undefined && driverId !== oldDriverId) {
                oldDriver = oldDriverId ? await getDocument('users', oldDriverId) : null;
                newDriver = driverId ? await getDocument('users', driverId) : null;
                changeDetails += `Driver: ${oldDriver?.username || 'Unassigned'} → ${newDriver?.username || 'Unassigned'}\n`;
            }

            // Send to tour managers
            if (managerEmails.length > 0) {
                const managerMailOptions = {
                    from: process.env.EMAIL_USER,
                    to: managerEmails.join(','),
                    subject: `Tour Assignment Update: ${tour.tour_reference}`,
                    text: `A tour assignment has been updated:\n\nTour: ${tour.tour_name} (${tour.tour_reference})\nSupplier: ${tour.supplier}\nStart Date: ${new Date(tour.startDate).toLocaleDateString()}\n\nChanges:\n${changeDetails}\n\nUpdated by: ${user.username}`
                };
                
                try {
                    await transporter.sendMail(managerMailOptions);
                    console.log('Email notification sent to tour managers:', managerEmails.join(', '));
                } catch (error) {
                    console.error('Error sending email to tour managers:', error);
                }
            }

            // Send to newly assigned driver
            if (driverId !== undefined && driverId !== oldDriverId && driverId && newDriver?.email) {
                const driverMailOptions = {
                    from: process.env.EMAIL_USER,
                    to: newDriver.email,
                    subject: `Tour Assignment: ${tour.tour_reference}`,
                    text: `You have been assigned to a tour:\n\nTour: ${tour.tour_name} (${tour.tour_reference})\nSupplier: ${tour.supplier}\nStart Date: ${new Date(tour.startDate).toLocaleDateString()}\nEnd Date: ${new Date(tour.endDate).toLocaleDateString()}\n${vehicleId && newVehicle ? `\nVehicle: ${newVehicle.licenceNumber}` : ''}\n\nPlease review the tour details in the app.\n\nAssigned by: ${user.username}`
                };
                
                try {
                    await transporter.sendMail(driverMailOptions);
                    console.log('Email notification sent to driver:', newDriver.email);
                } catch (error) {
                    console.error('Error sending email to driver:', error);
                }
            }

            // Notify old driver if they were unassigned
            if (driverId !== undefined && oldDriverId && driverId !== oldDriverId && oldDriver?.email) {
                const oldDriverMailOptions = {
                    from: process.env.EMAIL_USER,
                    to: oldDriver.email,
                    subject: `Tour Assignment Changed: ${tour.tour_reference}`,
                    text: `You have been unassigned from a tour:\n\nTour: ${tour.tour_name} (${tour.tour_reference})\nSupplier: ${tour.supplier}\nStart Date: ${new Date(tour.startDate).toLocaleDateString()}\n\nThe tour has been reassigned to another driver.\n\nUpdated by: ${user.username}`
                };
                
                try {
                    await transporter.sendMail(oldDriverMailOptions);
                    console.log('Email notification sent to previous driver:', oldDriver.email);
                } catch (error) {
                    console.error('Error sending email to previous driver:', error);
                }
            }
        }
    }

    res.status(200).json({ message: 'Tour updated', status: 1, data: { id: tourId } });
};

export const listTours = async (req: Request, res: Response): Promise<Response | void> => {
    const user = ensureUser(req, res);
    if (!user) return;

    const statusFilter = req.query.status as string | undefined;

    const filters: { field: string; op: any; value: any }[] = [{ field: 'organisationId', op: '==', value: user.organisationId }];
    if (statusFilter) {
        filters.push({ field: 'status', op: '==', value: statusFilter });
    }

    const vehicleId = req.query.vehicleId as string;
    if (vehicleId) {
        filters.push({ field: 'vehicleId', op: '==', value: vehicleId });
    }

    if (user.role === 'driver') {
        filters.push({ field: 'driverId', op: '==', value: user.uid });
    } else if (user.role === 'ops' || user.role === 'owner' || user.role === 'tour_manager') {
        // full org access
    } else {
        return res.status(403).json({ message: 'Forbidden', status: 0, data: null });
    }

    const data = await queryDocumentsByFilters('tours', filters);
    res.status(200).json({ message: 'Tours fetched', status: 1, data });
};

export const getTourById = async (req: Request, res: Response): Promise<Response | void> => {
    const user = ensureUser(req, res);
    if (!user) return;
    const tourId = req.params.id;

    const tour = await getDocument('tours', tourId);
    if (!tour) {
        return res.status(404).json({ message: 'Tour not found', status: 0, data: null });
    }
    if (tour.organisationId !== user.organisationId) {
        return res.status(403).json({ message: 'Tour does not belong to organisation', status: 0, data: null });
    }
    if (user.role === 'driver' && tour.driverId !== user.uid) {
        return res.status(403).json({ message: 'Drivers can only view their own tours', status: 0, data: null });
    }
    res.status(200).json({ message: 'Tour fetched', status: 1, data: { ...tour, id: tourId } });
};

export const deleteTour = async (req: Request, res: Response): Promise<Response | void> => {
    const user = ensureUser(req, res);
    if (!user) return;
    if (!requireRole(res, user.role, ['ops', 'owner', 'tour_manager'])) return;

    const tourId = req.params.id;
    const tour = await getDocument('tours', tourId);
    if (!tour) {
        return res.status(404).json({ message: 'Tour not found', status: 0, data: null });
    }
    if (tour.organisationId !== user.organisationId) {
        return res.status(403).json({ message: 'Tour does not belong to organisation', status: 0, data: null });
    }

    // Prevent deleting active tours
    if (tour.status === 'active') {
        return res.status(400).json({ message: 'Cannot delete an active tour', status: 0, data: null });
    }

    // If tour has a vehicle assigned, unassign it
    if (tour.vehicleId) {
        const vehicle = await getDocument('vehicles', tour.vehicleId);
        if (vehicle && vehicle.organisationId === user.organisationId) {
            // Only unassign if the vehicle is currently assigned to this tour's driver
            if (vehicle.currentDriverId === tour.driverId) {
                await updateDocument('vehicles', tour.vehicleId, {
                    currentDriverId: null,
                    currentDriverName: null,
                    assignedById: null,
                    assignedByName: null,
                    status: VehicleStatus.READY,
                    updatedAt: new Date().toISOString()
                });
            }
        }
    }

    await deleteDocument('tours', tourId);
    res.status(200).json({ message: 'Tour deleted', status: 1 });
};

// Inspections
export const submitInspection = async (req: Request, res: Response): Promise<Response | void> => {
    const user = ensureUser(req, res);
    if (!user) return;
    if (!requireRole(res, user.role, ['driver'])) return;

    const { tourId, vehicleId, type, results } = req.body as {
        tourId: string | null;
        vehicleId: string | null;
        type: string;
        results: InspectionResult[];
    };

    if (!type || !results) {
        return res.status(400).json({ message: 'Missing required fields', status: 0, data: null });
    }

    const template = inspection_types.find((t) => t.type === type);
    if (!template) {
        return res.status(400).json({ message: 'Invalid inspection type', status: 0, data: null });
    }

    let tour = null;
    if (tourId) {
        tour = await getDocument('tours', tourId);
        if (!tour) {
            return res.status(404).json({ message: 'Tour not found', status: 0, data: null });
        }
        if (tour.organisationId !== user.organisationId) {
            console.log(`Tour does not belong to organisation`)
            return res.status(403).json({ message: 'Tour does not belong to organisation', status: 0, data: null });
        }
        // console.log(tour, user.uid)
        // if (tour.driverId !== user.uid) {
        //     console.log(`Driver not assigned to this tour`)
        //     return res.status(403).json({ message: 'Driver not assigned to this tour', status: 0, data: null });
        // }
    }

    let vehicle = null;
    if (vehicleId) {
        vehicle = await getDocument('vehicles', vehicleId);
        if (!vehicle) {
            return res.status(404).json({ message: 'Vehicle not found', status: 0, data: null });
        }
        if (vehicle.organisationId !== user.organisationId) {
            return res.status(403).json({ message: 'Vehicle does not belong to organisation', status: 0, data: null });
        }
        if (tour && tour.vehicleId !== vehicleId) {
            return res.status(400).json({ message: 'Vehicle mismatch for this tour', status: 0, data: null });
        }
    }

    const inspectionId = `${tourId || 'no_tour'}_${type}_${user.uid}`;
    // const existing = await getDocument('inspections', inspectionId);
    // if (existing) {
    //     return res.status(409).json({ message: 'Inspection already submitted for this tour and type', status: 0, data: null });
    // }

    if (!Array.isArray(results)) {
        return res.status(400).json({ message: 'Results must be an array', status: 0, data: null });
    }

    // Transform tyre measurements from comma-separated strings to arrays with field labels
    const transformedResults = results.map((result) => {
        if (result.key === 'tyre_tread_depth' && typeof result.value === 'string') {
            const values = result.value.split(',').map(v => parseFloat(v.trim()));
            const fields = ['left_front', 'right_front', 'left_rear_inner', 'left_rear_outer', 'right_rear_inner', 'right_rear_outer'];
            const tyreMeasurements = fields.map((field, index) => ({
                position: field,
                value: values[index] || 0
            }));
            return {
                ...result,
                value: tyreMeasurements
            };
        }
        return result;
    });

    const safetyFailures = template.items
        .filter((item) => 'safetyCritical' in item && item.safetyCritical)
        .filter((item) => {
            const match = transformedResults.find((r) => r.key === item.key);
            return match ? match.value === false : true;
        });

    const now = new Date().toISOString();
    await setDocument('inspections', inspectionId, {
        tourId,
        vehicleId,
        organisationId: user.organisationId,
        driverId: user.uid,
        type,
        results: transformedResults,
        safetyFailures,
        createdAt: now,
        updatedAt: now
    });

    // Update vehicle with latest odometer reading
    if (vehicleId) {
        const odometerResult = results.find(r => r.key === 'odometer_reading');
        if (odometerResult && typeof odometerResult.value === 'string') {
            const odometerValue = parseFloat(odometerResult.value);
            if (!isNaN(odometerValue)) {
                await updateDocument('vehicles', vehicleId, { latest_odometer: odometerValue, updatedAt: now });
            }
        }
    }

    if (safetyFailures.length > 0 && vehicleId) {
        const issueRef = createDocRef('issues');
        await setDocument('issues', issueRef.id, {
            organisationId: user.organisationId,
            vehicleId,
            driverId: user.uid,
            tourId,
            severity: 'high',
            description: `Safety critical items failed: ${safetyFailures.map((i) => i.key).join(', ')}`,
            status: 'reported',
            createdAt: now,
            updatedAt: now
        });
        await updateDocument('vehicles', vehicleId, { status: 'issue', updatedAt: now });
    }

    res.status(201).json({ message: 'Inspection submitted', status: 1, data: { id: inspectionId } });
};

export const listInspectionsForTour = async (req: Request, res: Response): Promise<Response | void> => {
    const user = ensureUser(req, res);
    if (!user) return;
    const tourId = req.params.tourId;

    const tour = await getDocument('tours', tourId);
    if (!tour) {
        return res.status(404).json({ message: 'Tour not found', status: 0, data: null });
    }
    if (tour.organisationId !== user.organisationId) {
        return res.status(403).json({ message: 'Tour does not belong to organisation', status: 0, data: null });
    }
    if (user.role === 'driver' && tour.driverId !== user.uid) {
        return res.status(403).json({ message: 'Drivers can only view their own tour inspections', status: 0, data: null });
    }

    const data = await queryDocumentsByFilters('inspections', [{ field: 'tourId', op: '==', value: tourId }]);
    res.status(200).json({ message: 'Inspections fetched', status: 1, data });
};

// Issues
export const createIssue = async (req: Request, res: Response): Promise<Response | void> => {
    const user = ensureUser(req, res);
    if (!user) return;
    if (!requireRole(res, user.role, ['driver', 'owner', 'ops'])) return;

    const { vehicleId, severity, description, imageUrl, tourId } = req.body;
    if (!vehicleId || !severity || !description) {
        return res.status(400).json({ message: 'Missing required fields', status: 0, data: null });
    }

    const vehicle = await getDocument('vehicles', vehicleId);
    if (!vehicle) {
        return res.status(404).json({ message: 'Vehicle not found', status: 0, data: null });
    }
    if (vehicle.organisationId !== user.organisationId) {
        return res.status(403).json({ message: 'Vehicle does not belong to organisation', status: 0, data: null });
    }

    const now = new Date().toISOString();
    const issueRef = createDocRef('issues');
    await setDocument('issues', issueRef.id, {
        organisationId: user.organisationId,
        vehicleId,
        driverId: user.uid,
        tourId: tourId ?? null,
        severity,
        description,
        imageUrl: imageUrl ?? null,
        status: 'reported',
        reportedAt: now,
        createdAt: now,
        updatedAt: now
    });
    await updateDocument('vehicles', vehicleId, { status: VehicleStatus.ISSUE, updatedAt: now });

    res.status(201).json({ message: 'Issue created', status: 1, data: { id: issueRef.id } });
};

export const updateIssueStatus = async (req: Request, res: Response): Promise<Response | void> => {
    const user = ensureUser(req, res);
    if (!user) return;
    if (!requireRole(res, user.role, ['ops', 'owner'])) return;

    const issueId = req.params.id;
    const { status, notes } = req.body;
    const allowedStatuses = ['reported', 'scheduled', 'in_progress', 'done'];
    if (!allowedStatuses.includes(status)) {
        return res.status(400).json({ message: 'Invalid issue status', status: 0, data: null });
    }

    const issue = await getDocument('issues', issueId);
    if (!issue) {
        return res.status(404).json({ message: 'Issue not found', status: 0, data: null });
    }
    if (issue.organisationId !== user.organisationId) {
        return res.status(403).json({ message: 'Issue does not belong to organisation', status: 0, data: null });
    }

    const now = new Date().toISOString();
    const updates: any = { status, updatedAt: now };

    if (notes) {
        // Append notes to description or handle as separate field
        // Appending to description for immediate visibility
        const currentDesc = issue.description || '';
        const timestamp = new Date().toLocaleString();
        updates.description = `${currentDesc}\n\n[${timestamp} - Status: ${status}]\n${notes}`;
    }

    await updateDocument('issues', issueId, updates);

    if (status === 'done') {
        const openIssues = await queryDocumentsByFilters('issues', [
            { field: 'organisationId', op: '==', value: user.organisationId },
            { field: 'vehicleId', op: '==', value: issue.vehicleId },
            { field: 'status', op: '!=', value: 'done' }
        ]);
        if (openIssues.length === 0) {
            await updateDocument('vehicles', issue.vehicleId, { status: VehicleStatus.READY, updatedAt: now });
        }
    }

    res.status(200).json({ message: 'Issue status updated', status: 1, data: { id: issueId } });
};

export const listIssues = async (req: Request, res: Response): Promise<Response | void> => {
    const user = ensureUser(req, res);
    if (!user) return;

    const filters: { field: string; op: any; value: any }[] = [{ field: 'organisationId', op: '==', value: user.organisationId }];
    if (user.role === 'driver') {
        filters.push({ field: 'driverId', op: '==', value: user.uid });
    } else if (user.role === 'ops' || user.role === 'owner' || user.role === 'tour_manager') {
        // org-wide
    } else {
        return res.status(403).json({ message: 'Forbidden', status: 0, data: null });
    }

    const data = await queryDocumentsByFilters('issues', filters);
    res.status(200).json({ message: 'Issues fetched', status: 1, data });
};

// Floats
export const issueFloat = async (req: Request, res: Response): Promise<Response | void> => {
    const user = ensureUser(req, res);
    if (!user) return;
    if (!requireRole(res, user.role, ['ops', 'owner', 'tour_manager'])) return;

    const { driverId, amountCents, tourId, message } = req.body;

    // Debug logging
    console.log('issueFloat received:', {
        driverId,
        amountCents,
        amountCentsType: typeof amountCents,
        tourId,
        message,
        fullBody: req.body
    });

    if (!driverId || typeof amountCents !== 'number' || amountCents <= 0) {
        console.error('Validation failed:', {
            hasDriverId: !!driverId,
            amountCentsType: typeof amountCents,
            amountCentsValue: amountCents,
            isValidNumber: typeof amountCents === 'number' && amountCents > 0
        });
        return res.status(400).json({ message: 'Invalid float payload', status: 0, data: null });
    }

    const activeFloats = await queryDocumentsByFilters('floats', [
        { field: 'organisationId', op: '==', value: user.organisationId },
        { field: 'driverId', op: '==', value: driverId },
        { field: 'active', op: '==', value: true }
    ]);

    if (activeFloats.length > 0 && user.role !== 'owner') {
        return res.status(400).json({ message: 'Driver already has an active float', status: 0, data: null });
    }

    const now = new Date().toISOString();
    if (activeFloats.length > 0 && user.role === 'owner') {
        for (const float of activeFloats) {
            await updateDocument('floats', float.id, { active: false, closedAt: now, updatedAt: now });
        }
    }

    const floatRef = createDocRef('floats');
    await setDocument('floats', floatRef.id, {
        organisationId: user.organisationId,
        driverId,
        tourId: tourId ?? null,
        originalAmount: amountCents, // Store in cents
        remainingAmount: amountCents, // Store in cents
        active: true,
        issuedBy: user.uid,
        message: message || null,
        createdAt: now,
        updatedAt: now
    });

    res.status(201).json({ message: 'Float issued', status: 1, data: { id: floatRef.id } });
};

export const closeFloat = async (req: Request, res: Response): Promise<Response | void> => {
    const user = ensureUser(req, res);
    if (!user) return;
    if (!requireRole(res, user.role, ['ops', 'owner', 'tour_manager'])) return;

    const floatId = req.params.id;
    const float = await getDocument('floats', floatId);
    if (!float) {
        return res.status(404).json({ message: 'Float not found', status: 0, data: null });
    }
    if (float.organisationId !== user.organisationId) {
        return res.status(403).json({ message: 'Float does not belong to organisation', status: 0, data: null });
    }

    const now = new Date().toISOString();
    await updateDocument('floats', floatId, { active: false, status: 'closed', closedAt: now, updatedAt: now });
    res.status(200).json({ message: 'Float closed', status: 1, data: { id: floatId } });
};

export const listFloats = async (req: Request, res: Response): Promise<Response | void> => {
    const user = ensureUser(req, res);
    if (!user) return;

    const filters: { field: string; op: any; value: any }[] = [{ field: 'organisationId', op: '==', value: user.organisationId }];
    if (user.role === 'driver') {
        filters.push({ field: 'driverId', op: '==', value: user.uid });
    } else if (user.role === 'maintenance') {
        return res.status(403).json({ message: 'Maintenance cannot view floats', status: 0, data: null });
    } else if (user.role === 'ops' || user.role === 'owner' || user.role === 'tour_manager') {
        // org-wide
    } else {
        return res.status(403).json({ message: 'Forbidden', status: 0, data: null });
    }

    const data = await queryDocumentsByFilters('floats', filters);
    res.status(200).json({ message: 'Floats fetched', status: 1, data });
};

// Expenses
export const createExpense = async (req: Request, res: Response): Promise<Response | void> => {
    const user = ensureUser(req, res);
    if (!user) return;
    if (!requireRole(res, user.role, ['driver'])) return;

    const { category, amountCents, receiptUrl, tourId, floatId, description } = req.body;
    
    console.log('[createExpense] Request received:', {
        category,
        amountCents,
        tourId,
        floatId,
        description,
        hasReceiptUrl: !!receiptUrl,
        user: user.uid
    });
    
    // Upload receipt image if provided
    let receiptDownloadUrl: string | null = null;
    if (receiptUrl) {
        try {
            const base64Data = receiptUrl.replace(/^data:image\/[a-z]+;base64,/, '');
            const buffer = Buffer.from(base64Data, 'base64');
            const uint8Array = new Uint8Array(buffer);
            const receiptRef = ref(storage, `receipts/${Date.now()}_${user.uid}.jpg`);
            await uploadBytes(receiptRef, uint8Array);
            receiptDownloadUrl = await getDownloadURL(receiptRef);
        } catch (uploadError) {
            console.error('Error uploading receipt:', uploadError);
            return res.status(500).json({ message: 'Failed to upload receipt image', status: 0, data: null });
        }
    }

    if (!floatId) {
        console.log('Float ID required')
        return res.status(400).json({ message: 'Float ID required', status: 0, data: null });
    }

    // Get additional info for expense
    let vehicleLicence = '';
    let trailerLicence = '';
    let driverName = '';

    if (tourId) {
        const tour = await getDocument('tours', tourId);
        if (tour && tour.vehicleId) {
            const vehicle = await getDocument('vehicles', tour.vehicleId);
            if (vehicle) {
                vehicleLicence = vehicle.licenceNumber || '';
                trailerLicence = vehicle.trailerLicence || '';
                driverName = vehicle.currentDriverName || '';
            }
        }
    }

    const floatRef = getDocRef('floats', floatId);

    try {
        const now = new Date().toISOString();
        await runDbTransaction(async (transaction) => {
            const freshFloat = await transaction.get(floatRef);
            if (!freshFloat.exists()) {
                console.log('FLOAT_MISSING')
                throw new Error('FLOAT_MISSING');
            }
            const floatData = freshFloat.data() as any;
            console.log('[createExpense] Float data:', {
                id: floatId,
                organisationId: floatData.organisationId,
                driverId: floatData.driverId,
                remainingAmount: floatData.remainingAmount,
                amountCents: amountCents
            });
            
            if (floatData.organisationId !== user.organisationId || floatData.driverId !== user.uid) {
                console.log('[createExpense] FLOAT_INVALID - org or driver mismatch');
                console.log('  Expected org:', user.organisationId, 'Got:', floatData.organisationId);
                console.log('  Expected driver:', user.uid, 'Got:', floatData.driverId);
                throw new Error('FLOAT_INVALID');
            }
            if (floatData.remainingAmount < amountCents) {
                console.log('[createExpense] INSUFFICIENT_FUNDS');
                console.log('  Remaining:', floatData.remainingAmount, 'Requested:', amountCents);
                throw new Error('INSUFFICIENT_FUNDS');
            }

            console.log('[createExpense] Validation passed, creating expense...');

            const expenseRef = createDocRef('expenses');
            transaction.set(expenseRef, {
                organisationId: user.organisationId,
                driverId: user.uid,
                floatId,
                tourId,
                category,
                amount: amountCents, // Store in cents
                receiptUrl: receiptDownloadUrl ?? null,
                description: description || '',
                vehicleLicence,
                trailerLicence,
                driverName,
                status: 'pending',
                createdAt: now,
                updatedAt: now
            });

            const adjustment = category === 'WIFI' ? amountCents : -amountCents;
            transaction.update(floatRef, {
                remainingAmount: floatData.remainingAmount + adjustment, // Update in cents
                updatedAt: now
            });
        });

        res.status(201).json({ message: 'Expense created', status: 1 });
    } catch (error: any) {
        console.error('[createExpense] Error:', error);
        if (error?.message === 'INSUFFICIENT_FUNDS') {
            console.log('[createExpense] Returning insufficient funds error');
            return res.status(400).json({ message: 'Insufficient float balance', status: 0, data: null });
        }
        if (error?.message === 'FLOAT_INVALID') {
            console.log('[createExpense] Returning invalid float error');
            return res.status(403).json({ message: 'Invalid float or unauthorized', status: 0, data: null });
        }
        if (error?.message === 'FLOAT_MISSING') {
            console.log('[createExpense] Returning float missing error');
            return res.status(404).json({ message: 'Float not found', status: 0, data: null });
        }
        console.log('[createExpense] Returning generic error');
        return res.status(500).json({ message: 'Failed to create expense', status: 0, data: null });
    }
};

export const updateExpenseStatus = async (req: Request, res: Response): Promise<Response | void> => {
    const user = ensureUser(req, res);
    if (!user) return;
    if (!requireRole(res, user.role, ['ops', 'owner'])) return;

    const expenseId = req.params.id;
    const { action } = req.body;
    if (!['approve', 'reject'].includes(action)) {
        return res.status(400).json({ message: 'Invalid action', status: 0, data: null });
    }

    const expense = await getDocument('expenses', expenseId);
    if (!expense) {
        return res.status(404).json({ message: 'Expense not found', status: 0, data: null });
    }
    if (expense.organisationId !== user.organisationId) {
        return res.status(403).json({ message: 'Expense does not belong to organisation', status: 0, data: null });
    }
    if (expense.status !== 'pending') {
        return res.status(400).json({ message: 'Expense already processed', status: 0, data: null });
    }

    const now = new Date().toISOString();
    await updateDocument('expenses', expenseId, {
        status: action === 'approve' ? 'approved' : 'rejected',
        approvedBy: user.uid,
        approvedAt: now,
        updatedAt: now
    });

    res.status(200).json({ message: 'Expense status updated', status: 1, data: { id: expenseId } });
};

export const deleteExpense = async (req: Request, res: Response): Promise<Response | void> => {
    const user = ensureUser(req, res);
    if (!user) return;
    if (!requireRole(res, user.role, ['owner'])) return;

    const expenseId = req.params.id;
    const expense = await getDocument('expenses', expenseId);
    if (!expense) {
        return res.status(404).json({ message: 'Expense not found', status: 0, data: null });
    }
    if (expense.organisationId !== user.organisationId) {
        return res.status(403).json({ message: 'Expense does not belong to organisation', status: 0, data: null });
    }

    const floatRef = expense.floatId ? getDocRef('floats', expense.floatId) : null;

    try {
        const now = new Date().toISOString();
        await runDbTransaction(async (transaction) => {
            if (floatRef) {
                const floatSnap = await transaction.get(floatRef);
                if (floatSnap.exists()) {
                    const floatData = floatSnap.data() as any;
                    if (floatData.organisationId === user.organisationId) {
                        const reverseAdjustment = expense.category === 'WIFI' ? -(expense.amount || 0) : (expense.amount || 0);
                        transaction.update(floatRef, {
                            remainingAmount: (floatData.remainingAmount || 0) + reverseAdjustment,
                            updatedAt: now
                        });
                    }
                }
            }
            transaction.delete(getDocRef('expenses', expenseId));
        });
        res.status(200).json({ message: 'Expense deleted', status: 1 });
    } catch (error) {
        res.status(500).json({ message: 'Failed to delete expense', status: 0, data: null });
    }
};

export const listExpenses = async (req: Request, res: Response): Promise<Response | void> => {
    const user = ensureUser(req, res);
    if (!user) return;

    const filters: { field: string; op: any; value: any }[] = [{ field: 'organisationId', op: '==', value: user.organisationId }];

    // Allow filtering by floatId
    const floatId = req.query.floatId as string;
    if (floatId) {
        filters.push({ field: 'floatId', op: '==', value: floatId });
    }

    if (user.role === 'driver') {
        filters.push({ field: 'driverId', op: '==', value: user.uid });
    } else if (user.role === 'maintenance') {
        return res.status(403).json({ message: 'Maintenance cannot view expenses', status: 0, data: null });
    } else if (user.role === 'ops' || user.role === 'owner') {
        // organisation scope
    } else {
        return res.status(403).json({ message: 'Forbidden', status: 0, data: null });
    }

    const data = await queryDocumentsByFilters('expenses', filters);
    res.status(200).json({ message: 'Expenses fetched', status: 1, data });
};

// Vehicles
export const addVehicle = async (req: Request, res: Response): Promise<Response | void> => {
    const user = ensureUser(req, res);
    if (!user) return;
    if (!requireRole(res, user.role, ['ops', 'owner'])) return;

    const { model, licenceNumber, modelYear, trailerId, trailerModel, trailerLicence, odometer, lastServiced, nextService } = req.body;
    if (!model || !licenceNumber || !modelYear || !odometer || !lastServiced || !nextService) {
        return res.status(400).json({ message: 'Missing required fields', status: 0, data: null });
    }

    const vehicleRef = createDocRef('vehicles');
    const now = new Date().toISOString();
    await setDocument('vehicles', vehicleRef.id, {
        organisationId: user.organisationId,
        model,
        licenceNumber,
        modelYear: parseInt(modelYear),
        trailerId: trailerId || null,
        trailerModel: trailerModel || null,
        trailerLicence: trailerLicence || null,
        odometer: parseInt(odometer),
        lastServiced,
        nextService,
        status: VehicleStatus.READY,
        currentDriverId: null,
        currentDriverName: null,
        assignedById: null,
        assignedByName: null,
        createdBy: user.uid,
        createdAt: now,
        updatedAt: now
    });

    res.status(201).json({ message: 'Vehicle added', status: 1, data: { id: vehicleRef.id } });
};

export const getVehicles = async (req: Request, res: Response): Promise<Response | void> => {
    const user = ensureUser(req, res);
    if (!user) return;

    const filters: { field: string; op: any; value: any }[] = [{ field: 'organisationId', op: '==', value: user.organisationId }];

    // Allow filtering by driverId
    const driverId = req.query.driverId as string;
    if (driverId) {
        filters.push({ field: 'currentDriverId', op: '==', value: driverId });
    }

    // All roles can view vehicles in their org, but perhaps restrict based on role if needed
    // For now, allow all

    const data = await queryDocumentsByFilters('vehicles', filters);
    
    // Sort vehicles by sortOrder field (if present), vehicles without sortOrder go to the end
    const sortedData = (data as any[]).sort((a, b) => {
        const orderA = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
        const orderB = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
        return orderA - orderB;
    });
    
    res.status(200).json({ message: 'Vehicles fetched', status: 1, data: sortedData });
};

export const getDrivers = async (req: Request, res: Response): Promise<Response | void> => {
    const user = ensureUser(req, res);
    if (!user) return;

    const filters: { field: string; op: any; value: any }[] = [
        { field: 'organisationId', op: '==', value: user.organisationId },
        { field: 'role', op: '==', value: 'driver' }
    ];

    const data = await queryDocumentsByFilters('users', filters);
    res.status(200).json({ message: 'Drivers fetched', status: 1, data });
};

export const getVehicleById = async (req: Request, res: Response): Promise<Response | void> => {
    const user = ensureUser(req, res);
    if (!user) return;
    const vehicleId = req.params.id;

    const vehicle = await getDocument('vehicles', vehicleId);
    if (!vehicle) {
        return res.status(404).json({ message: 'Vehicle not found', status: 0, data: null });
    }
    if (vehicle.organisationId !== user.organisationId) {
        return res.status(403).json({ message: 'Vehicle does not belong to organisation', status: 0, data: null });
    }
    res.status(200).json({ message: 'Success', status: 1, data: { ...vehicle, id: vehicleId } });
};

export const updateVehicle = async (req: Request, res: Response): Promise<Response | void> => {
    const user = ensureUser(req, res);
    if (!user) return;
    if (!requireRole(res, user.role, ['ops', 'owner'])) return;

    const vehicleId = req.params.id;
    const updates = req.body;
    console.log('Updates:', updates);
    const vehicle = await getDocument('vehicles', vehicleId);
    if (!vehicle) {
        return res.status(404).json({ message: 'Vehicle not found', status: 0, data: null });
    }
    if (vehicle.organisationId !== user.organisationId) {
        return res.status(403).json({ message: 'Vehicle does not belong to organisation', status: 0, data: null });
    }

    const now = new Date().toISOString();
    updates.updatedAt = now;

    await updateDocument('vehicles', vehicleId, updates);
    res.status(200).json({ message: 'Vehicle updated', status: 1, data: { id: vehicleId } });
};

export const getToursForVehicle = async (req: Request, res: Response): Promise<Response | void> => {
    const user = ensureUser(req, res);
    if (!user) return;
    const vehicleId = req.params.id;

    const vehicle = await getDocument('vehicles', vehicleId);
    if (!vehicle) {
        return res.status(404).json({ message: 'Vehicle not found', status: 0, data: null });
    }
    if (vehicle.organisationId !== user.organisationId) {
        return res.status(403).json({ message: 'Vehicle does not belong to organisation', status: 0, data: null });
    }

    const data = await queryDocumentsByFilters('tours', [{ field: 'vehicleId', op: '==', value: vehicleId }]);
    // Sort by startDate descending
    data.sort((a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime());
    res.status(200).json({ message: 'Success', status: 1, data });
};

export const getIssuesForVehicle = async (req: Request, res: Response): Promise<Response | void> => {
    const user = ensureUser(req, res);
    if (!user) return;
    const vehicleId = req.params.id;

    const vehicle = await getDocument('vehicles', vehicleId);
    if (!vehicle) {
        return res.status(404).json({ message: 'Vehicle not found', status: 0, data: null });
    }
    if (vehicle.organisationId !== user.organisationId) {
        return res.status(403).json({ message: 'Vehicle does not belong to organisation', status: 0, data: null });
    }

    const data = await queryDocumentsByFilters('issues', [{ field: 'vehicleId', op: '==', value: vehicleId }]);
    res.status(200).json({ message: 'Success', status: 1, data });
};

export const getInspectionsForVehicle = async (req: Request, res: Response): Promise<Response | void> => {
    const user = ensureUser(req, res);
    if (!user) return;
    const vehicleId = req.params.id;

    const vehicle = await getDocument('vehicles', vehicleId);
    if (!vehicle) {
        return res.status(404).json({ message: 'Vehicle not found', status: 0, data: null });
    }
    if (vehicle.organisationId !== user.organisationId) {
        return res.status(403).json({ message: 'Vehicle does not belong to organisation', status: 0, data: null });
    }

    const data = await queryDocumentsByFilters('inspections', [{ field: 'vehicleId', op: '==', value: vehicleId }]);
    res.status(200).json({ message: 'Success', status: 1, data });
};

export const deleteVehicle = async (req: Request, res: Response): Promise<Response | void> => {
    const user = ensureUser(req, res);
    if (!user) return;
    if (!requireRole(res, user.role, ['ops', 'owner'])) return;

    const vehicleId = req.params.id;
    const vehicle = await getDocument('vehicles', vehicleId);
    if (!vehicle) {
        return res.status(404).json({ message: 'Vehicle not found', status: 0, data: null });
    }
    if (vehicle.organisationId !== user.organisationId) {
        return res.status(403).json({ message: 'Vehicle does not belong to organisation', status: 0, data: null });
    }

    // Check if vehicle is assigned to any active tours
    const activeTours = await queryDocumentsByFilters('tours', [
        { field: 'organisationId', op: '==', value: user.organisationId },
        { field: 'vehicleId', op: '==', value: vehicleId },
        { field: 'status', op: 'in', value: ['planned', 'active'] }
    ]);
    if (activeTours.length > 0) {
        return res.status(400).json({ message: 'Cannot delete vehicle assigned to active tours', status: 0, data: null });
    }

    await deleteDocument('vehicles', vehicleId);
    res.status(200).json({ message: 'Vehicle deleted', status: 1 });
};

// Trailers
export const addTrailer = async (req: Request, res: Response): Promise<Response | void> => {
    const user = ensureUser(req, res);
    if (!user) return;
    if (!requireRole(res, user.role, ['ops', 'owner'])) return;

    const { model, licenceNumber, modelYear } = req.body;
    if (!model || !licenceNumber || !modelYear) {
        return res.status(400).json({ message: 'Missing required fields', status: 0, data: null });
    }

    const trailerRef = createDocRef('trailers');
    const now = new Date().toISOString();
    await setDocument('trailers', trailerRef.id, {
        organisationId: user.organisationId,
        model,
        licenceNumber,
        modelYear: parseInt(modelYear),
        status: VehicleStatus.READY,
        createdBy: user.uid,
        createdAt: now,
        updatedAt: now
    });

    res.status(201).json({ message: 'Trailer added', status: 1, data: { id: trailerRef.id } });
};

export const getTrailers = async (req: Request, res: Response): Promise<Response | void> => {
    const user = ensureUser(req, res);
    if (!user) return;

    const filters: { field: string; op: any; value: any }[] = [{ field: 'organisationId', op: '==', value: user.organisationId }];
    // All roles can view trailers in their org

    const data = await queryDocumentsByFilters('trailers', filters);
    res.status(200).json({ message: 'Trailers fetched', status: 1, data });
};

// Users
export const addUser = async (req: Request, res: Response): Promise<Response | void> => {
    const user = ensureUser(req, res);
    if (!user) return;
    if (!requireRole(res, user.role, ['ops', 'owner'])) return;

    const { passportNumber, pdpNumber, role, pdpExpiry, pin, name, username, email } = req.body;
    const { organisationId } = user;
    console.log('addUser', req.body);
    if (!username || !role) {
        return res.status(400).json({ message: 'Missing required fields', status: 0, data: null });
    }

    const validRoles: Role[] = ['driver', 'ops', 'owner', 'tour_manager'];
    if (!validRoles.includes(role)) {
        return res.status(400).json({ message: 'Invalid role', status: 0, data: null });
    }

    let passportDocumentUrl: string | undefined;
    let pdpDocumentUrl: string | undefined;

    if (role === 'driver') {
        if (!passportNumber || !pdpNumber || !pdpExpiry) {
            return res.status(400).json({ message: 'Missing compliance data for driver', status: 0, data: null });
        }
        if (!req.files || !req.files.passportDocument || !req.files.pdpDocument) {
            return res.status(400).json({ message: 'Missing compliance documents for driver', status: 0, data: null });
        }

        const { v4: uuidv4 } = await import('uuid');

        const passportDocument = req.files.passportDocument as any; // UploadedFile
        const pdpDocument = req.files.pdpDocument as any;

        // Ensure directory exists
        const uploadDir = path.join(__dirname, '../../uploads/compliance');
        fs.mkdirSync(uploadDir, { recursive: true });

        try {
            // Process Passport document
            const passportExt = path.extname(passportDocument.name);
            const passportFilename = `${uuidv4()}${passportExt}`;
            const passportLocalPath = path.join(uploadDir, passportFilename);
            await passportDocument.mv(passportLocalPath);

            const passportStorageRef = ref(storage, `compliance/${passportFilename}`);
            await uploadBytes(passportStorageRef, new Uint8Array(fs.readFileSync(passportLocalPath)));
            passportDocumentUrl = await getDownloadURL(passportStorageRef);

            // Process PDP document
            const pdpExt = path.extname(pdpDocument.name);
            const pdpFilename = `${uuidv4()}${pdpExt}`;
            const pdpLocalPath = path.join(uploadDir, pdpFilename);
            await pdpDocument.mv(pdpLocalPath);

            const pdpStorageRef = ref(storage, `compliance/${pdpFilename}`);
            await uploadBytes(pdpStorageRef, new Uint8Array(fs.readFileSync(pdpLocalPath)));
            pdpDocumentUrl = await getDownloadURL(pdpStorageRef);
        } catch (error) {
            console.error('File processing error:', error);
            return res.status(500).json({ message: 'Failed to process files', status: 0, data: null });
        }
    }

    const success = await createUser(username, pin, role, organisationId, name, passportNumber, pdpNumber, pdpExpiry, passportDocumentUrl, pdpDocumentUrl, email);
    if (success) {
        res.status(201).json({ message: 'User added', status: 1, data: { username } });
    } else {
        res.status(409).json({ message: 'User already exists', status: 0, data: null });
    }
};

export const getUsers = async (req: Request, res: Response): Promise<Response | void> => {
    const user = ensureUser(req, res);
    if (!user) return;
    if (!requireRole(res, user.role, ['ops', 'owner'])) return;

    const filters: { field: string; op: any; value: any }[] = [{ field: 'organisationId', op: '==', value: user.organisationId }];
    const data = await queryDocumentsByFilters('users', filters);
    res.status(200).json({ message: 'Users fetched', status: 1, data });
};

export const getUserById = async (req: Request, res: Response): Promise<Response | void> => {
    const user = ensureUser(req, res);
    if (!user) return;
    if (!requireRole(res, user.role, ['ops', 'owner'])) return;

    const userId = req.params.id;
    const userDoc = await getDocument('users', userId);
    if (!userDoc) {
        return res.status(404).json({ message: 'User not found', status: 0, data: null });
    }
    if (userDoc.organisationId !== user.organisationId) {
        return res.status(403).json({ message: 'User does not belong to organisation', status: 0, data: null });
    }
    res.status(200).json({ message: 'User fetched', status: 1, data: { ...userDoc, id: userId } });
};

export const updateUser = async (req: Request, res: Response): Promise<Response | void> => {
    const user = ensureUser(req, res);
    if (!user) return;
    if (!requireRole(res, user.role, ['ops', 'owner'])) return;

    const userId = req.params.id;
    const updates = req.body;

    const userDoc = await getDocument('users', userId);
    if (!userDoc) {
        return res.status(404).json({ message: 'User not found', status: 0, data: null });
    }
    if (userDoc.organisationId !== user.organisationId) {
        return res.status(403).json({ message: 'User does not belong to organisation', status: 0, data: null });
    }

    // Validate role if provided
    if (updates.role) {
        const validRoles: Role[] = ['driver', 'ops', 'owner', 'tour_manager'];
        if (!validRoles.includes(updates.role)) {
            return res.status(400).json({ message: 'Invalid role', status: 0, data: null });
        }
    }

    const now = new Date().toISOString();
    updates.updatedAt = now;

    await updateDocument('users', userId, updates);
    res.status(200).json({ message: 'User updated', status: 1, data: { id: userId } });
};

export const deleteUser = async (req: Request, res: Response): Promise<Response | void> => {
    const user = ensureUser(req, res);
    if (!user) return;
    if (!requireRole(res, user.role, ['ops', 'owner'])) return;

    const userId = req.params.id;
    const userDoc = await getDocument('users', userId);
    if (!userDoc) {
        return res.status(404).json({ message: 'User not found', status: 0, data: null });
    }
    if (userDoc.organisationId !== user.organisationId) {
        return res.status(403).json({ message: 'User does not belong to organisation', status: 0, data: null });
    }

    // Prevent deleting self
    if (userId === user.uid) {
        return res.status(400).json({ message: 'Cannot delete yourself', status: 0, data: null });
    }

    await deleteDocument('users', userId);
    res.status(200).json({ message: 'User deleted', status: 1 });
};
