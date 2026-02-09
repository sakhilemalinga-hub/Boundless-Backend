import tourKmData from '../../tour-km-data.json';

export interface ServiceIndicator {
  color: 'green' | 'amber' | 'red';
  remainingKm: number;
  cumulativeKm: number;
}

export interface BrakeIndicator {
  color: 'green' | 'amber' | 'red';
  remainingKm: number;
  cumulativeKm: number;
}

/**
 * Calculate service indicator color based on remaining km
 * @param remainingKm - Kilometers remaining until service
 * @returns Color code: 'green', 'amber', or 'red'
 */
export function getServiceColor(remainingKm: number): 'green' | 'amber' | 'red' {
  if (remainingKm < 0) return 'red';
  if (remainingKm < 1000) return 'red';
  if (remainingKm < 5000) return 'amber';
  return 'green';
}

/**
 * Calculate brake indicator color based on remaining km
 * @param remainingKm - Kilometers remaining until brake service
 * @returns Color code: 'green', 'amber', or 'red'
 */
export function getBrakeColor(remainingKm: number): 'green' | 'amber' | 'red' {
  if (remainingKm < 0) return 'red';
  if (remainingKm < 1000) return 'red';
  if (remainingKm < 5000) return 'amber';
  return 'green';
}

/**
 * Get tour km from reference data
 * @param tourReference - Tour reference code (e.g., 'ZAPAN')
 * @returns Kilometers for the tour, or 0 if not found
 */
export function getTourKm(tourReference: string): number {
  const tourData = (tourKmData as any)[tourReference];
  return tourData?.km || 0;
}

/**
 * Calculate service indicators for a list of tours
 * @param tours - Array of tours sorted by start date
 * @param currentOdometer - Current vehicle odometer reading
 * @param nextServiceThreshold - Next service threshold (e.g., 50000)
 * @param lastServiceOdo - Odometer reading at last service
 * @returns Array of service indicators for each tour
 */
export function calculateServiceIndicators(
  tours: Array<{ id: string; tour_reference: string; startDate: string }>,
  currentOdometer: number,
  nextServiceThreshold: number,
  lastServiceOdo: number = 0
): Record<string, ServiceIndicator> {
  const indicators: Record<string, ServiceIndicator> = {};
  let cumulativeKm = currentOdometer;

  // Sort tours by start date
  const sortedTours = [...tours].sort((a, b) => 
    new Date(a.startDate).getTime() - new Date(b.startDate).getTime()
  );

  for (const tour of sortedTours) {
    const tourKm = getTourKm(tour.tour_reference);
    cumulativeKm += tourKm;
    
    const kmSinceLastService = cumulativeKm - lastServiceOdo;
    const remainingKm = nextServiceThreshold - kmSinceLastService;
    
    indicators[tour.id] = {
      color: getServiceColor(remainingKm),
      remainingKm,
      cumulativeKm
    };
  }

  return indicators;
}

/**
 * Calculate brake indicators for a list of tours
 * @param tours - Array of tours sorted by start date
 * @param currentOdometer - Current vehicle odometer reading
 * @param nextBrakeThreshold - Next brake service threshold
 * @param lastBrakeOdo - Odometer reading at last brake service
 * @returns Array of brake indicators for each tour
 */
export function calculateBrakeIndicators(
  tours: Array<{ id: string; tour_reference: string; startDate: string }>,
  currentOdometer: number,
  nextBrakeThreshold: number,
  lastBrakeOdo: number = 0
): Record<string, BrakeIndicator> {
  const indicators: Record<string, BrakeIndicator> = {};
  let cumulativeKm = currentOdometer;

  // Sort tours by start date
  const sortedTours = [...tours].sort((a, b) => 
    new Date(a.startDate).getTime() - new Date(b.startDate).getTime()
  );

  for (const tour of sortedTours) {
    const tourKm = getTourKm(tour.tour_reference);
    cumulativeKm += tourKm;
    
    const kmSinceLastBrake = cumulativeKm - lastBrakeOdo;
    const remainingKm = nextBrakeThreshold - kmSinceLastBrake;
    
    indicators[tour.id] = {
      color: getBrakeColor(remainingKm),
      remainingKm,
      cumulativeKm
    };
  }

  return indicators;
}
