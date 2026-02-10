import tourKmData from '../../tour-km-data.json';

export interface ServiceIndicator {
  color: 'green' | 'amber' | 'red';
  remainingKm: number;
  cumulativeKm: number;
}

export interface MaintenanceIndicators {
  tyres: ServiceIndicator;
  wheels: ServiceIndicator;
  service: ServiceIndicator;
  brakes: ServiceIndicator;
}

/**
 * Calculate indicator color based on remaining km
 * @param remainingKm - Kilometers remaining until service
 * @returns Color code: 'green', 'amber', or 'red'
 */
export function getIndicatorColor(remainingKm: number): 'green' | 'amber' | 'red' {
  if (remainingKm < 0) return 'red';
  if (remainingKm < 1000) return 'red';
  if (remainingKm < 5000) return 'amber';
  return 'green';
}

/**
 * Get tour km from reference data
 * @param tourReference - Tour reference code (e.g., 'ZAPAN', 'Golf Tour', etc.)
 * @returns Kilometers for the tour, or 0 if not found
 */
export function getTourKm(tourReference: string): number {
  if (!tourReference) return 0;
  
  // Try exact match first
  const tourData = (tourKmData as any)[tourReference];
  if (tourData?.km) return tourData.km;
  
  // Try case-insensitive match
  const upperRef = tourReference.toUpperCase();
  for (const [key, value] of Object.entries(tourKmData)) {
    if (key.toUpperCase() === upperRef) {
      return (value as any).km || 0;
    }
  }
  
  // Try partial match (e.g., "Golf Tour" matches "GOLF")
  for (const [key, value] of Object.entries(tourKmData)) {
    if (upperRef.includes(key.toUpperCase()) || key.toUpperCase().includes(upperRef)) {
      return (value as any).km || 0;
    }
  }
  
  // Default to 0 if no match found
  console.warn(`No km data found for tour reference: ${tourReference}`);
  return 0;
}

/**
 * Calculate all maintenance indicators for a list of tours
 * @param tours - Array of tours sorted by start date
 * @param currentOdometer - Current vehicle odometer reading
 * @param intervals - Maintenance intervals for the vehicle
 * @param lastServiceOdos - Last service odometer readings
 * @returns Record of maintenance indicators for each tour
 */
export function calculateMaintenanceIndicators(
  tours: Array<{ id: string; tour_reference: string; startDate: string }>,
  currentOdometer: number,
  intervals: {
    tyres: number;
    alignmentBalancing: number;
    service: number;
    brakes: number;
  },
  lastServiceOdos: {
    tyres: number;
    wheels: number;
    service: number;
    brakes: number;
  }
): Record<string, MaintenanceIndicators> {
  const indicators: Record<string, MaintenanceIndicators> = {};
  let cumulativeKm = currentOdometer;

  // Sort tours by start date
  const sortedTours = [...tours].sort((a, b) => 
    new Date(a.startDate).getTime() - new Date(b.startDate).getTime()
  );

  for (const tour of sortedTours) {
    const tourKm = getTourKm(tour.tour_reference);
    cumulativeKm += tourKm;
    
    // Calculate remaining km for each maintenance type
    const tyresRemaining = (lastServiceOdos.tyres + intervals.tyres) - cumulativeKm;
    const wheelsRemaining = (lastServiceOdos.wheels + intervals.alignmentBalancing) - cumulativeKm;
    const serviceRemaining = (lastServiceOdos.service + intervals.service) - cumulativeKm;
    const brakesRemaining = (lastServiceOdos.brakes + intervals.brakes) - cumulativeKm;
    
    console.log(`[calculateMaintenanceIndicators] Tour ${tour.id} (${tour.tour_reference}):`, {
      tourKm,
      cumulativeKm,
      serviceRemaining,
      serviceColor: getIndicatorColor(serviceRemaining)
    });
    
    indicators[tour.id] = {
      tyres: {
        color: getIndicatorColor(tyresRemaining),
        remainingKm: tyresRemaining,
        cumulativeKm
      },
      wheels: {
        color: getIndicatorColor(wheelsRemaining),
        remainingKm: wheelsRemaining,
        cumulativeKm
      },
      service: {
        color: getIndicatorColor(serviceRemaining),
        remainingKm: serviceRemaining,
        cumulativeKm
      },
      brakes: {
        color: getIndicatorColor(brakesRemaining),
        remainingKm: brakesRemaining,
        cumulativeKm
      }
    };
  }

  return indicators;
}

// Keep backward compatibility
export function calculateServiceIndicators(
  tours: Array<{ id: string; tour_reference: string; startDate: string }>,
  currentOdometer: number,
  nextServiceThreshold: number,
  lastServiceOdo: number = 0
): Record<string, ServiceIndicator> {
  const indicators: Record<string, ServiceIndicator> = {};
  let cumulativeKm = currentOdometer;

  const sortedTours = [...tours].sort((a, b) => 
    new Date(a.startDate).getTime() - new Date(b.startDate).getTime()
  );

  for (const tour of sortedTours) {
    const tourKm = getTourKm(tour.tour_reference);
    cumulativeKm += tourKm;
    
    const kmSinceLastService = cumulativeKm - lastServiceOdo;
    const remainingKm = nextServiceThreshold - kmSinceLastService;
    
    indicators[tour.id] = {
      color: getIndicatorColor(remainingKm),
      remainingKm,
      cumulativeKm
    };
  }

  return indicators;
}

export function calculateBrakeIndicators(
  tours: Array<{ id: string; tour_reference: string; startDate: string }>,
  currentOdometer: number,
  nextBrakeThreshold: number,
  lastBrakeOdo: number = 0
): Record<string, ServiceIndicator> {
  const indicators: Record<string, ServiceIndicator> = {};
  let cumulativeKm = currentOdometer;

  const sortedTours = [...tours].sort((a, b) => 
    new Date(a.startDate).getTime() - new Date(b.startDate).getTime()
  );

  for (const tour of sortedTours) {
    const tourKm = getTourKm(tour.tour_reference);
    cumulativeKm += tourKm;
    
    const kmSinceLastBrake = cumulativeKm - lastBrakeOdo;
    const remainingKm = nextBrakeThreshold - kmSinceLastBrake;
    
    indicators[tour.id] = {
      color: getIndicatorColor(remainingKm),
      remainingKm,
      cumulativeKm
    };
  }

  return indicators;
}
