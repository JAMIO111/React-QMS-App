/** A cut-down QIF 3 Results document: two characteristics (a diameter and a flatness) and one result set for serial SN-7. */
export const SAMPLE_QIF = `<?xml version="1.0" encoding="UTF-8"?>
<QIFDocument xmlns="http://qifstandards.org/xsd/qif3" versionQIF="3.0.0" idMax="40">
  <FileUnits><PrimaryUnits><LinearUnit><SIUnitName>meter</SIUnitName><UnitName>mm</UnitName></LinearUnit>
    <AngularUnit><UnitName>degree</UnitName></AngularUnit></PrimaryUnits></FileUnits>
  <Product><PartSet n="1"><Part id="1"><Name>BRK-100</Name></Part></PartSet></Product>
  <Characteristics>
    <CharacteristicDefinitions n="2">
      <DiameterCharacteristicDefinition id="10"><Tolerance><MaxValue>0.05</MaxValue><MinValue>-0.05</MinValue></Tolerance></DiameterCharacteristicDefinition>
      <FlatnessCharacteristicDefinition id="11"><ToleranceValue>0.02</ToleranceValue></FlatnessCharacteristicDefinition>
    </CharacteristicDefinitions>
    <CharacteristicNominals n="2">
      <DiameterCharacteristicNominal id="20"><CharacteristicDefinitionId>10</CharacteristicDefinitionId><Name>Bore</Name><TargetValue>25</TargetValue></DiameterCharacteristicNominal>
      <FlatnessCharacteristicNominal id="21"><CharacteristicDefinitionId>11</CharacteristicDefinitionId><Name>Face</Name></FlatnessCharacteristicNominal>
    </CharacteristicNominals>
    <CharacteristicItems n="2">
      <DiameterCharacteristicItem id="30"><Name>Bore &amp; seat</Name><CharacteristicDesignator><Designator>12</Designator></CharacteristicDesignator><CharacteristicNominalId>20</CharacteristicNominalId></DiameterCharacteristicItem>
      <FlatnessCharacteristicItem id="31"><Name>Face flatness</Name><CharacteristicDesignator><Designator>13</Designator></CharacteristicDesignator><CharacteristicNominalId>21</CharacteristicNominalId></FlatnessCharacteristicItem>
    </CharacteristicItems>
  </Characteristics>
  <MeasurementsResults><MeasurementResultsSet><MeasurementResults id="35">
    <MeasuredCharacteristics><CharacteristicMeasurements n="2">
      <DiameterCharacteristicMeasurement id="36"><Status><CharacteristicStatusEnum>PASS</CharacteristicStatusEnum></Status><Value>25.012</Value><CharacteristicItemId>30</CharacteristicItemId></DiameterCharacteristicMeasurement>
      <FlatnessCharacteristicMeasurement id="37"><Status><CharacteristicStatusEnum>FAIL</CharacteristicStatusEnum></Status><Value>0.031</Value><CharacteristicItemId>31</CharacteristicItemId></FlatnessCharacteristicMeasurement>
    </CharacteristicMeasurements></MeasuredCharacteristics>
    <ThisResultsInstanceQPId><SerialNumber>SN-7</SerialNumber></ThisResultsInstanceQPId>
  </MeasurementResults></MeasurementResultsSet></MeasurementsResults>
</QIFDocument>`;
