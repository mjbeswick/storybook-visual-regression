import type { Meta, StoryObj } from '@storybook/react-vite';
import { QRCodeComponent } from '../components/QRCodeComponent';

const meta: Meta<typeof QRCodeComponent> = {
  title: 'QRCode',
  component: QRCodeComponent,
  parameters: {
    layout: 'centered',
  },
  argTypes: {
    text: {
      control: 'text',
      description: 'The text to encode in the QR code',
    },
    size: {
      control: { type: 'range', min: 50, max: 500, step: 10 },
      description: 'Size of the QR code',
    },
    backgroundColor: {
      control: 'color',
      description: 'Background color',
    },
    color: {
      control: 'color',
      description: 'Foreground color',
    },
    errorCorrectionLevel: {
      control: 'select',
      options: ['L', 'M', 'Q', 'H'],
      description: 'Error correction level',
    },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

// Create 100 stories with different configurations
export const QRCode1: Story = {
  args: {
    text: 'https://example.com/qr-1',
    size: 100,
    backgroundColor: '#ffffff',
    color: '#000000',
    errorCorrectionLevel: 'L',
  },
};

export const QRCode2: Story = {
  args: {
    text: 'https://example.com/qr-2',
    size: 120,
    backgroundColor: '#f0f0f0',
    color: '#333333',
    errorCorrectionLevel: 'M',
  },
};

export const QRCode3: Story = {
  args: {
    text: 'https://example.com/qr-3',
    size: 140,
    backgroundColor: '#ffffff',
    color: '#666666',
    errorCorrectionLevel: 'Q',
  },
};

export const QRCode4: Story = {
  args: {
    text: 'https://example.com/qr-4',
    size: 160,
    backgroundColor: '#f0f0f0',
    color: '#000000',
    errorCorrectionLevel: 'H',
  },
};

export const QRCode5: Story = {
  args: {
    text: 'https://example.com/qr-5',
    size: 180,
    backgroundColor: '#ffffff',
    color: '#333333',
    errorCorrectionLevel: 'L',
  },
};

// Generate the remaining 95 stories programmatically
const generateStory = (i: number): Story => ({
  args: {
    text: `https://example.com/qr-${i}`,
    size: 100 + (i % 5) * 20,
    backgroundColor: i % 2 === 0 ? '#ffffff' : '#f0f0f0',
    color: i % 3 === 0 ? '#000000' : i % 3 === 1 ? '#333333' : '#666666',
    errorCorrectionLevel: ['L', 'M', 'Q', 'H'][i % 4] as 'L' | 'M' | 'Q' | 'H',
  },
});

// Export stories 6-100
for (let i = 6; i <= 100; i++) {
  (meta as any)[`QRCode${i}`] = generateStory(i);
}
