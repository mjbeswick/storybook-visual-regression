import type { Meta, StoryObj } from '@storybook/react';
import { BarcodeComponent } from '../components/Barcode';

const meta = {
  title: 'Components/Barcode',
  component: BarcodeComponent,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'Professional barcode component using react-barcode library. Supports multiple formats including EAN-13, EAN-8, UPC, CODE128, CODE39, and more.',
      },
    },
  },
  tags: ['autodocs'],
  argTypes: {
    code: {
      control: 'text',
      description: 'Barcode value (will be validated and padded according to format)',
    },
    width: {
      control: { type: 'number', min: 1, max: 5, step: 0.1 },
      description: 'Bar width multiplier (1-5)',
    },
    height: {
      control: { type: 'number', min: 50, max: 200, step: 10 },
      description: 'Height of the barcode in pixels',
    },
    showText: {
      control: 'boolean',
      description: 'Whether to display the barcode value below the bars',
    },
    format: {
      control: 'select',
      options: [
        'EAN13',
        'EAN8',
        'UPC',
        'CODE128',
        'CODE39',
        'ITF14',
        'MSI',
        'pharmacode',
        'codabar',
      ],
      description: 'Barcode format type',
    },
  },
} satisfies Meta<typeof BarcodeComponent>;

export default meta;
type Story = StoryObj<typeof meta>;

// Generate 100 stories with different EAN-13 codes
const stories: Story[] = [];

// Common EAN-13 prefixes for different countries/companies
const prefixes = [
  '123456',
  '234567',
  '345678',
  '456789',
  '567890',
  '678901',
  '789012',
  '890123',
  '901234',
  '012345',
];

for (let i = 1; i <= 100; i++) {
  const prefixIndex = Math.floor((i - 1) / 10);
  const suffix = (i - 1) % 10;
  const productCode = `${prefixes[prefixIndex]}${suffix.toString().padStart(6, '0')}`;

  stories.push({
    args: {
      code: productCode,
      width: 2,
      height: 100,
      showText: true,
      format: 'EAN13',
    },
    parameters: {
      docs: {
        description: {
          story: `EAN-13 barcode for product code ${productCode}`,
        },
      },
    },
  });
}

// Additional example stories
export const SmallBarcode: Story = {
  args: {
    code: '123456789012',
    width: 1.5,
    height: 80,
    showText: true,
    format: 'EAN13',
  },
  parameters: {
    docs: {
      description: {
        story: 'Small EAN-13 barcode example',
      },
    },
  },
};

export const LargeBarcode: Story = {
  args: {
    code: '987654321098',
    width: 3,
    height: 150,
    showText: true,
    format: 'EAN13',
  },
  parameters: {
    docs: {
      description: {
        story: 'Large EAN-13 barcode example',
      },
    },
  },
};

export const BarcodeWithoutText: Story = {
  args: {
    code: '555555555555',
    width: 2,
    height: 100,
    showText: false,
    format: 'EAN13',
  },
  parameters: {
    docs: {
      description: {
        story: 'EAN-13 barcode without text display',
      },
    },
  },
};

export const ShortCode: Story = {
  args: {
    code: '123',
    width: 2,
    height: 100,
    showText: true,
    format: 'EAN13',
  },
  parameters: {
    docs: {
      description: {
        story: 'Short code example (will be padded to 12 digits for EAN-13)',
      },
    },
  },
};

export const EAN8Barcode: Story = {
  args: {
    code: '1234567',
    width: 2,
    height: 100,
    showText: true,
    format: 'EAN8',
  },
  parameters: {
    docs: {
      description: {
        story: 'EAN-8 barcode example (8-digit format)',
      },
    },
  },
};

export const UPCBarcode: Story = {
  args: {
    code: '12345678901',
    width: 2,
    height: 100,
    showText: true,
    format: 'UPC',
  },
  parameters: {
    docs: {
      description: {
        story: 'UPC barcode example (12-digit format)',
      },
    },
  },
};

export const Code128Barcode: Story = {
  args: {
    code: 'Hello World!',
    width: 2,
    height: 100,
    showText: true,
    format: 'CODE128',
  },
  parameters: {
    docs: {
      description: {
        story: 'CODE128 barcode example (supports alphanumeric)',
      },
    },
  },
};

export const Code39Barcode: Story = {
  args: {
    code: 'HELLO',
    width: 2,
    height: 100,
    showText: true,
    format: 'CODE39',
  },
  parameters: {
    docs: {
      description: {
        story: 'CODE39 barcode example (uppercase alphanumeric)',
      },
    },
  },
};

// Export all generated stories
export const Barcode001: Story = stories[0];
export const Barcode002: Story = stories[1];
export const Barcode003: Story = stories[2];
export const Barcode004: Story = stories[3];
export const Barcode005: Story = stories[4];
export const Barcode006: Story = stories[5];
export const Barcode007: Story = stories[6];
export const Barcode008: Story = stories[7];
export const Barcode009: Story = stories[8];
export const Barcode010: Story = stories[9];
export const Barcode011: Story = stories[10];
export const Barcode012: Story = stories[11];
export const Barcode013: Story = stories[12];
export const Barcode014: Story = stories[13];
export const Barcode015: Story = stories[14];
export const Barcode016: Story = stories[15];
export const Barcode017: Story = stories[16];
export const Barcode018: Story = stories[17];
export const Barcode019: Story = stories[18];
export const Barcode020: Story = stories[19];
export const Barcode021: Story = stories[20];
export const Barcode022: Story = stories[21];
export const Barcode023: Story = stories[22];
export const Barcode024: Story = stories[23];
export const Barcode025: Story = stories[24];
export const Barcode026: Story = stories[25];
export const Barcode027: Story = stories[26];
export const Barcode028: Story = stories[27];
export const Barcode029: Story = stories[28];
export const Barcode030: Story = stories[29];
export const Barcode031: Story = stories[30];
export const Barcode032: Story = stories[31];
export const Barcode033: Story = stories[32];
export const Barcode034: Story = stories[33];
export const Barcode035: Story = stories[34];
export const Barcode036: Story = stories[35];
export const Barcode037: Story = stories[36];
export const Barcode038: Story = stories[37];
export const Barcode039: Story = stories[38];
export const Barcode040: Story = stories[39];
export const Barcode041: Story = stories[40];
export const Barcode042: Story = stories[41];
export const Barcode043: Story = stories[42];
export const Barcode044: Story = stories[43];
export const Barcode045: Story = stories[44];
export const Barcode046: Story = stories[45];
export const Barcode047: Story = stories[46];
export const Barcode048: Story = stories[47];
export const Barcode049: Story = stories[48];
export const Barcode050: Story = stories[49];
export const Barcode051: Story = stories[50];
export const Barcode052: Story = stories[51];
export const Barcode053: Story = stories[52];
export const Barcode054: Story = stories[53];
export const Barcode055: Story = stories[54];
export const Barcode056: Story = stories[55];
export const Barcode057: Story = stories[56];
export const Barcode058: Story = stories[57];
export const Barcode059: Story = stories[58];
export const Barcode060: Story = stories[59];
export const Barcode061: Story = stories[60];
export const Barcode062: Story = stories[61];
export const Barcode063: Story = stories[62];
export const Barcode064: Story = stories[63];
export const Barcode065: Story = stories[64];
export const Barcode066: Story = stories[65];
export const Barcode067: Story = stories[66];
export const Barcode068: Story = stories[67];
export const Barcode069: Story = stories[68];
export const Barcode070: Story = stories[69];
export const Barcode071: Story = stories[70];
export const Barcode072: Story = stories[71];
export const Barcode073: Story = stories[72];
export const Barcode074: Story = stories[73];
export const Barcode075: Story = stories[74];
export const Barcode076: Story = stories[75];
export const Barcode077: Story = stories[76];
export const Barcode078: Story = stories[77];
export const Barcode079: Story = stories[78];
export const Barcode080: Story = stories[79];
export const Barcode081: Story = stories[80];
export const Barcode082: Story = stories[81];
export const Barcode083: Story = stories[82];
export const Barcode084: Story = stories[83];
export const Barcode085: Story = stories[84];
export const Barcode086: Story = stories[85];
export const Barcode087: Story = stories[86];
export const Barcode088: Story = stories[87];
export const Barcode089: Story = stories[88];
export const Barcode090: Story = stories[89];
export const Barcode091: Story = stories[90];
export const Barcode092: Story = stories[91];
export const Barcode093: Story = stories[92];
export const Barcode094: Story = stories[93];
export const Barcode095: Story = stories[94];
export const Barcode096: Story = stories[95];
export const Barcode097: Story = stories[96];
export const Barcode098: Story = stories[97];
export const Barcode099: Story = stories[98];
export const Barcode100: Story = stories[99];
