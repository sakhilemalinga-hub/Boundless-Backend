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
 * Calculate all maintenance indicators for a list of tours
 * @param tours - Array of tours sorted by start date
 * @param currentOdometer - Current vehicle odometer reading
 * @param intervals - Maintenance intervals for the vehicle
 * @param lastServiceOdos - Last service odometer readings
 * @returns Record of maintenance indicators for each tour
 */
export function calculateMaintenanceIndicators(
  tours: Array<{ id: string; tour_reference: string; startDate: string; estimated_km?: number }>,
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
    // Use estimated_km from tour if available, otherwise default to 0
    const tourKm = tour.estimated_km || 0;
    cumulativeKm += tourKm;

    // Calculate remaining km for each maintenance type
    const tyresRemaining = (lastServiceOdos.tyres + intervals.tyres) - cumulativeKm;
    const wheelsRemaining = (lastServiceOdos.wheels + intervals.alignmentBalancing) - cumulativeKm;
    const serviceRemaining = (lastServiceOdos.service + intervals.service) - cumulativeKm;
    const brakesRemaining = (lastServiceOdos.brakes + intervals.brakes) - cumulativeKm;

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
  tours: Array<{ id: string; tour_reference: string; startDate: string; estimated_km?: number }>,
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
    const tourKm = tour.estimated_km || 0;
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
  tours: Array<{ id: string; tour_reference: string; startDate: string; estimated_km?: number }>,
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
    const tourKm = tour.estimated_km || 0;
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


