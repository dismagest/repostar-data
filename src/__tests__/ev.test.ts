import { describe, expect, it } from 'vitest';
import { mapConnector, parseDatex2, parseSite, speedTier } from '../ev.ts';
import { EV_CONNECTOR_BIT, evShardOf } from '../contract.ts';

const SITE = `<egi:energyInfrastructureSite id="2023000001" version="">
<fac:name><com:values><com:value lang="es">Playa de la Patacona</com:value></com:values></fac:name>
<fac:operatingHours xsi:type="fac:OperatingHoursSpecification" id="24/7" version=""><fac:label/></fac:operatingHours>
<fac:locationReference xsi:type="loc:PointLocation">
<loc:_locationReferenceExtension><loc:facilityLocation><locx:address><locx:postcode>46120</locx:postcode>
<locx:addressLine order="1"><locx:type>generalTextLine</locx:type><locx:text><com:values><com:value lang="es">Dirección: Passeig Marítim de la Patacona 55</com:value></com:values></locx:text></locx:addressLine>
<locx:addressLine order="2"><locx:type>generalTextLine</locx:type><locx:text><com:values><com:value lang="es">Municipio: Alboraia/Alboraya</com:value></com:values></locx:text></locx:addressLine>
<locx:addressLine order="3"><locx:type>generalTextLine</locx:type><locx:text><com:values><com:value lang="es">Provincia: Valencia/Val&#232;ncia</com:value></com:values></locx:text></locx:addressLine>
</locx:address></loc:facilityLocation></loc:_locationReferenceExtension>
<loc:coordinatesForDisplay><loc:latitude>39.4898</loc:latitude><loc:longitude>-0.32543</loc:longitude></loc:coordinatesForDisplay>
</fac:locationReference>
<fac:operator xsi:type="fac:OrganisationSpecification" id="ES*GAI" version=""><fac:name><com:values><com:value lang="es">Gaia Green Tech S.L.</com:value></com:values></fac:name></fac:operator>
<egi:typeOfSite>onstreet</egi:typeOfSite>
<egi:energyInfrastructureStation id="2023000001_1" version="">
<egi:authenticationAndIdentificationMethods>rfid</egi:authenticationAndIdentificationMethods>
<egi:authenticationAndIdentificationMethods>apps</egi:authenticationAndIdentificationMethods>
<egi:refillPoint xsi:type="egi:ElectricChargingPoint" id="P1" version="">
<egi:connector><egi:connectorType>iec62196T2</egi:connectorType><egi:maxPowerAtSocket>22000.0</egi:maxPowerAtSocket></egi:connector>
<egi:connector><egi:connectorType>iec62196T2</egi:connectorType><egi:maxPowerAtSocket>22000.0</egi:maxPowerAtSocket></egi:connector>
</egi:refillPoint>
<egi:refillPoint xsi:type="egi:ElectricChargingPoint" id="P2" version="">
<egi:connector><egi:connectorType>iec62196T2COMBO</egi:connectorType><egi:maxPowerAtSocket>150000.0</egi:maxPowerAtSocket></egi:connector>
<egi:connector><egi:connectorType>chademo</egi:connectorType><egi:maxPowerAtSocket>50000.0</egi:maxPowerAtSocket></egi:connector>
</egi:refillPoint>
</egi:energyInfrastructureStation>
</egi:energyInfrastructureSite>`;

describe('parseSite', () => {
  const site = parseSite(SITE, '2023000001')!;
  it('extrae identidad, dirección y operador', () => {
    expect(site.name).toBe('Playa de la Patacona');
    expect(site.operator).toBe('Gaia Green Tech S.L.');
    expect(site.operatorId).toBe('ES*GAI');
    expect(site.address).toBe('Passeig Marítim de la Patacona 55');
    expect(site.municipality).toBe('Alboraia/Alboraya');
    expect(site.postcode).toBe('46120');
    expect(site.lat).toBeCloseTo(39.4898, 4);
    expect(site.open24h).toBe(true);
    expect(site.siteType).toBe('onstreet');
    expect(site.auth.sort()).toEqual(['apps', 'rfid']);
  });
  it('agrupa conectores por tipo y potencia, de más a menos potente', () => {
    expect(site.points).toBe(2);
    expect(site.maxKw).toBe(150);
    expect(site.connectors).toEqual([
      { type: 'ccs2', kw: 150, n: 1 },
      { type: 'chademo', kw: 50, n: 1 },
      { type: 'type2', kw: 22, n: 2 },
    ]);
  });
  it('descarta emplazamientos sin coordenadas o sin cargadores', () => {
    expect(parseSite(SITE.replace('39.4898', '0'), 'x')).toBeNull();
    expect(parseSite(SITE.replace(/<egi:refillPoint[\s\S]*<\/egi:refillPoint>/, ''), 'x')).toBeNull();
  });
  it('parseDatex2 recorre varios bloques y deduplica ids', () => {
    const xml = `<d2:payload>${SITE}${SITE}${SITE.replace('2023000001', '2023000002')}</d2:payload>`;
    expect(parseDatex2(xml).map((s) => s.id)).toEqual(['2023000001', '2023000002']);
  });
});

describe('helpers', () => {
  it('mapConnector normaliza los tipos DATEX2', () => {
    expect(mapConnector('iec62196T2COMBO')).toBe('ccs2');
    expect(mapConnector('domesticF')).toBe('schuko');
    expect(mapConnector('iec60309x2single16')).toBe('cee');
    expect(mapConnector('rarísimo')).toBe('other');
  });
  it('speedTier clasifica por potencia', () => {
    expect([speedTier(7), speedTier(22), speedTier(50), speedTier(350)]).toEqual([0, 1, 2, 3]);
  });
  it('máscara de conectores y shard estables', () => {
    expect(EV_CONNECTOR_BIT.ccs2).toBe(1);
    expect(EV_CONNECTOR_BIT.chademo).toBe(2);
    expect(evShardOf('2023000001')).toBe(evShardOf('2023000001'));
    expect(evShardOf('abc')).toBeLessThan(32);
  });
});
