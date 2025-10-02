import React from 'react';
import Barcode from 'react-barcode';

export interface BarcodeProps {
  code: string;
  width?: number;
  height?: number;
  showText?: boolean;
  format?:
    | 'EAN13'
    | 'EAN8'
    | 'UPC'
    | 'CODE128'
    | 'CODE39'
    | 'ITF14'
    | 'MSI'
    | 'pharmacode'
    | 'codabar';
}

export const BarcodeComponent: React.FC<BarcodeProps> = ({
  code,
  width = 2,
  height = 100,
  showText = true,
  format = 'EAN13',
}) => {
  // Ensure we have a valid code for the format
  const getValidCode = (inputCode: string, barcodeFormat: string): string => {
    switch (barcodeFormat) {
      case 'EAN13':
        // EAN-13 needs 12 digits + checksum
        const paddedEAN13 = inputCode.padStart(12, '0').slice(0, 12);
        return paddedEAN13;
      case 'EAN8':
        // EAN-8 needs 7 digits + checksum
        const paddedEAN8 = inputCode.padStart(7, '0').slice(0, 7);
        return paddedEAN8;
      case 'UPC':
        // UPC needs 11 digits + checksum
        const paddedUPC = inputCode.padStart(11, '0').slice(0, 11);
        return paddedUPC;
      case 'CODE128':
      case 'CODE39':
        // These can handle alphanumeric codes
        return inputCode;
      default:
        return inputCode;
    }
  };

  const validCode = getValidCode(code, format);

  return (
    <div
      className="barcode-container"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#ffffff',
        border: '1px solid #e0e0e0',
        borderRadius: '4px',
        padding: '8px',
        fontFamily: 'monospace',
        minWidth: '200px',
        minHeight: '120px',
      }}
    >
      <Barcode
        value={validCode}
        format={format}
        width={width}
        height={height}
        displayValue={showText}
        fontSize={12}
        textAlign="center"
        textPosition="bottom"
        textMargin={4}
        margin={0}
        background="#ffffff"
        lineColor="#000000"
        renderer="svg"
      />
    </div>
  );
};
