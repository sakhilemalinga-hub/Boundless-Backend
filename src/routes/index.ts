import { Router } from 'express';

import { secrets } from '../server';
import {
    getInspectionItems,
    createTour,
    updateTour,
    deleteTour,
    listTours,
    getTourById,
    submitInspection,
    listInspectionsForTour,
    createIssue,
    updateIssueStatus,
    listIssues,
    issueFloat,
    closeFloat,
    listFloats,
    createExpense,
    updateExpenseStatus,
    deleteExpense,
    listExpenses,
    addVehicle,
    getVehicles,
    updateVehicle,
    deleteVehicle,
    getDrivers,
    getVehicleById,
    getToursForVehicle,
    getIssuesForVehicle,
    getInspectionsForVehicle,
    addTrailer,
    getTrailers,
    addUser,
    getUsers,
    getUserById,
    updateUser,
    deleteUser,
    getTaskAssigned
} from '../handlers/method';
import { authenticate, register } from '../handlers/auth/auth';
import { authorize } from '../handlers/auth/middleware/authentication';
import { getAssignedTask } from '../helpers/api';

const router = Router();

// Health check endpoint
router.get('/health', (_, res) => {
    res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

router.get('/secrets', (_, res) => {
    res.json({ success: true, BASE_URL: secrets?.BASE_URL });
});

router.post('/authenticate', authenticate);
router.post('/register', register);
router.get('/get-inspection-items', authorize, getInspectionItems);

// Tours
router.post('/tours', authorize, createTour);
router.patch('/tours/:id', authorize, updateTour);
router.delete('/tours/:id', authorize, deleteTour);
router.get('/tours', authorize, listTours);
router.get('/tours/:id', authorize, getTourById);
router.post('/get-assigned-task', authorize, getTaskAssigned);
// Inspections
router.post('/submit-inspection', authorize, submitInspection);
router.get('/tours/:tourId/inspections', authorize, listInspectionsForTour);

// Issues
router.post('/issues', authorize, createIssue);
router.patch('/issues/:id/status', authorize, updateIssueStatus);
router.get('/issues', authorize, listIssues);

// Floats
router.post('/floats', authorize, issueFloat);
router.patch('/floats/:id/close', authorize, closeFloat);
router.get('/floats', authorize, listFloats);

// Expenses
router.post('/expenses', authorize, createExpense);
router.patch('/expenses/:id/status', authorize, updateExpenseStatus);
router.delete('/expenses/:id', authorize, deleteExpense);
router.get('/expenses', authorize, listExpenses);

// Vehicles
router.post('/add-vehicle', authorize, addVehicle);
router.get('/get-vehicles', authorize, getVehicles);
router.get('/vehicles/:id', authorize, getVehicleById);
router.put('/vehicles/:id', authorize, updateVehicle);
router.get('/vehicles/:id/tours', authorize, getToursForVehicle);
router.get('/vehicles/:id/issues', authorize, getIssuesForVehicle);
router.get('/vehicles/:id/inspections', authorize, getInspectionsForVehicle);
router.delete('/vehicles/:id', authorize, deleteVehicle);

// Trailers
router.post('/add-trailer', authorize, addTrailer);
router.get('/get-trailers', authorize, getTrailers);

// Drivers
router.get('/get-drivers', authorize, getDrivers);

// Users
router.post('/add-user', authorize, addUser);
router.get('/users', authorize, getUsers);
router.get('/users/:id', authorize, getUserById);
router.put('/users/:id', authorize, updateUser);
router.delete('/users/:id', authorize, deleteUser);

export default router;
