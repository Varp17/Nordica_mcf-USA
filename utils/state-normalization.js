const STATE_MAP = {
  'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR', 'california': 'CA',
  'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE', 'florida': 'FL', 'georgia': 'GA',
  'hawaii': 'HI', 'idaho': 'ID', 'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA',
  'kansas': 'KS', 'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
  'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS', 'missouri': 'MO',
  'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH',
  'oklahoma': 'OK', 'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT', 'vermont': 'VT',
  'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV', 'wisconsin': 'WI', 'wyoming': 'WY',
  'district of columbia': 'DC', 'american samoa': 'AS', 'guam': 'GU', 'northern mariana islands': 'MP',
  'puerto rico': 'PR', 'virgin islands': 'VI'
};

export function normalizeState(stateName) {
  if (!stateName) return stateName;
  const name = stateName.toLowerCase().trim();
  
  if (name.length === 2) return name.toUpperCase();
  
  const mapped = STATE_MAP[name];
  if (!mapped && stateName.length > 2) {
    // If it's not a US state, it might be a CA province. 
    // We'll return the uppercase version and let the fulfillment service validate against the country.
    return stateName.toUpperCase();
  }
  return mapped || stateName.toUpperCase();
}

export default { normalizeState };
