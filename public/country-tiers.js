const COUNTRY_TIERS = {
  AD: 1, AE: 1, AF: 3, AG: 2, AI: 2, AL: 2, AM: 2, AO: 3, AQ: 0, AR: 2,
  AS: 2, AT: 1, AU: 1, AW: 2, AX: 2, AZ: 2, BA: 2, BB: 2, BD: 3, BE: 1,
  BF: 3, BG: 2, BH: 1, BI: 3, BJ: 3, BL: 2, BM: 1, BN: 2, BO: 3, BQ: 2,
  BR: 2, BS: 2, BT: 2, BV: 0, BW: 2, BY: 2, BZ: 2, CA: 1, CC: 0, CD: 3,
  CF: 3, CG: 3, CH: 1, CI: 3, CK: 2, CL: 2, CM: 3, CN: 2, CO: 2, CR: 2,
  CU: 2, CV: 2, CW: 2, CX: 0, CY: 1, CZ: 1, DE: 1, DJ: 3, DK: 1, DM: 2,
  DO: 2, DZ: 3, EC: 2, EE: 1, EG: 3, EH: 0, ER: 3, ES: 1, ET: 3, FI: 1,
  FJ: 2, FK: 2, FM: 2, FO: 2, FR: 1, GA: 3, GB: 1, GD: 2, GE: 2, GF: 2,
  GG: 1, GH: 2, GI: 1, GL: 2, GM: 3, GN: 3, GP: 2, GQ: 3, GR: 2, GS: 0,
  GT: 2, GU: 2, GW: 3, GY: 2, HK: 1, HM: 0, HN: 3, HR: 2, HT: 3, HU: 2,
  ID: 3, IE: 1, IL: 1, IM: 1, IN: 3, IO: 0, IQ: 3, IR: 2, IS: 1, IT: 1,
  JE: 1, JM: 2, JO: 2, JP: 1, KE: 3, KG: 3, KH: 3, KI: 2, KM: 3, KN: 2,
  KP: 3, KR: 1, KW: 1, KY: 1, KZ: 2, LA: 3, LB: 3, LC: 2, LI: 1, LK: 2,
  LR: 3, LS: 3, LT: 2, LU: 1, LV: 2, LY: 3, MA: 2, MC: 1, MD: 2, ME: 2,
  MF: 2, MG: 3, MH: 2, MK: 2, ML: 3, MM: 3, MN: 3, MO: 2, MP: 2, MQ: 2,
  MR: 3, MS: 2, MT: 2, MU: 2, MV: 2, MW: 3, MX: 2, MY: 2, MZ: 3, NA: 2,
  NC: 2, NE: 3, NF: 2, NG: 3, NI: 3, NL: 1, NO: 1, NP: 3, NR: 2, NU: 2,
  NZ: 1, OM: 1, PA: 2, PE: 2, PF: 2, PG: 3, PH: 3, PK: 3, PL: 2, PM: 2,
  PN: 0, PR: 2, PS: 2, PT: 2, PW: 2, PY: 2, QA: 1, RE: 2, RO: 2, RS: 2,
  RU: 2, RW: 3, SA: 1, SB: 2, SC: 2, SD: 3, SE: 1, SG: 1, SH: 2, SI: 1,
  SJ: 2, SK: 1, SL: 3, SM: 1, SN: 3, SO: 3, SR: 2, SS: 3, ST: 3, SV: 2,
  SX: 2, SY: 3, SZ: 3, TC: 2, TD: 3, TF: 0, TG: 3, TH: 2, TJ: 3, TK: 2,
  TL: 3, TM: 3, TN: 3, TO: 2, TR: 2, TT: 2, TV: 2, TW: 1, TZ: 3, UA: 2,
  UG: 3, UM: 0, US: 1, UY: 2, UZ: 3, VA: 2, VC: 2, VE: 3, VG: 2, VI: 2,
  VN: 3, VU: 2, WF: 2, WS: 2, YE: 3, YT: 2, ZA: 2, ZM: 3, ZW: 3,
};

function countryTier(code) {
  return COUNTRY_TIERS[String(code ?? "").toUpperCase()] ?? 0;
}
