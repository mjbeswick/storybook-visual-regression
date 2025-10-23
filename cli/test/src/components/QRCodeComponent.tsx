import React, { useEffect, useRef } from 'react';
import QRCode from 'qrcode';

interface QRCodeComponentProps {
  text: string;
  size?: number;
  color?: string;
  backgroundColor?: string;
  errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
  margin?: number;
  type?: 'image/png' | 'image/jpeg' | 'image/webp';
}

export const QRCodeComponent: React.FC<QRCodeComponentProps> = ({
  text,
  size = 200,
  color = '#000000',
  backgroundColor = '#ffffff',
  errorCorrectionLevel = 'M',
  margin = 4,
  type = 'image/png',
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const generateQRCode = async () => {
      if (!canvasRef.current) return;

      try {
        const options = {
          width: size,
          margin: margin,
          color: {
            dark: color,
            light: backgroundColor,
          },
          errorCorrectionLevel: errorCorrectionLevel,
        };

        await QRCode.toCanvas(canvasRef.current, text, options);
      } catch (error) {
        console.error('Error generating QR code:', error);
      }
    };

    generateQRCode();
  }, [text, size, color, backgroundColor, errorCorrectionLevel, margin]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '10px',
        padding: '20px',
        backgroundColor: '#f5f5f5',
        borderRadius: '8px',
        fontFamily: 'Arial, sans-serif',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          border: '2px solid #ddd',
          borderRadius: '4px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
        }}
      />
      <div
        style={{
          textAlign: 'center',
          fontSize: '12px',
          color: '#666',
          maxWidth: size,
          wordBreak: 'break-all',
        }}
      >
        {text}
      </div>
    </div>
  );
};
