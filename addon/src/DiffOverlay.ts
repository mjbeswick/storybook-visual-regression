/**
 * Diff Overlay Component for Visual Regression Testing
 *
 * This component is injected into the Storybook preview iframe
 * and shows diff images overlaid on the story content.
 */

interface DiffOverlayState {
  isVisible: boolean;
  showDiff: boolean;
  showExpected: boolean;
  diffImagePath?: string;
  actualImagePath?: string;
  expectedImagePath?: string;
  storyId?: string;
}

class DiffOverlay {
  private state: DiffOverlayState = {
    isVisible: false,
    showDiff: true,
    showExpected: false,
  };

  private overlay: HTMLDivElement | null = null;
  private controls: HTMLDivElement | null = null;

  constructor() {
    this.createOverlay();
    this.setupEventListeners();
  }

  private createOverlay(): void {
    // Create main overlay container
    this.overlay = document.createElement('div');
    this.overlay.id = 'visual-regression-overlay';
    this.overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 9999;
      display: none;
    `;

    // Create controls container
    this.controls = document.createElement('div');
    this.controls.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: rgba(0, 0, 0, 0.8);
      color: white;
      padding: 12px;
      border-radius: 8px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      pointer-events: auto;
      z-index: 10000;
      display: none;
    `;

    // Create control buttons
    const diffButton = this.createButton('Show Diff', () => this.toggleDiff());
    const expectedButton = this.createButton('Show Expected', () => this.toggleExpected());

    this.controls.appendChild(diffButton);
    this.controls.appendChild(expectedButton);

    // Create image containers
    const diffContainer = document.createElement('div');
    diffContainer.id = 'diff-container';
    diffContainer.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      display: none;
    `;

    const expectedContainer = document.createElement('div');
    expectedContainer.id = 'expected-container';
    expectedContainer.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      display: none;
      opacity: 0.5;
    `;

    this.overlay.appendChild(diffContainer);
    this.overlay.appendChild(expectedContainer);

    document.body.appendChild(this.overlay);
    document.body.appendChild(this.controls);
  }

  private createButton(text: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.textContent = text;
    button.style.cssText = `
      background: #3b82f6;
      color: white;
      border: none;
      padding: 6px 12px;
      margin: 0 4px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
    `;
    button.addEventListener('click', onClick);
    return button;
  }

  private setupEventListeners(): void {
    // Listen for messages from the addon
    window.addEventListener('message', (event) => {
      if (event.data.type === 'visual-regression-show-diff') {
        this.showDiff(event.data);
      } else if (event.data.type === 'visual-regression-hide-diff') {
        this.hide();
      }
    });
  }

  private toggleDiff(): void {
    this.state.showDiff = !this.state.showDiff;
    this.updateDisplay();
    this.updateButtonText();
  }

  private toggleExpected(): void {
    this.state.showExpected = !this.state.showExpected;
    this.updateDisplay();
    this.updateButtonText();
  }

  private updateButtonText(): void {
    if (this.controls) {
      const buttons = this.controls.querySelectorAll('button');
      if (buttons[0]) buttons[0].textContent = this.state.showDiff ? 'Hide Diff' : 'Show Diff';
      if (buttons[1])
        buttons[1].textContent = this.state.showExpected ? 'Hide Expected' : 'Show Expected';
    }
  }

  private updateDisplay(): void {
    if (!this.overlay) return;

    const diffContainer = this.overlay.querySelector('#diff-container') as HTMLDivElement;
    const expectedContainer = this.overlay.querySelector('#expected-container') as HTMLDivElement;

    if (diffContainer) {
      diffContainer.style.display = this.state.showDiff ? 'block' : 'none';
    }

    if (expectedContainer) {
      expectedContainer.style.display = this.state.showExpected ? 'block' : 'none';
    }
  }

  public showDiff(data: {
    storyId: string;
    diffImagePath?: string;
    actualImagePath?: string;
    expectedImagePath?: string;
  }): void {
    this.state = {
      isVisible: true,
      showDiff: true,
      showExpected: false,
      ...data,
    };

    if (this.overlay) {
      this.overlay.style.display = 'block';
    }

    if (this.controls) {
      this.controls.style.display = 'block';
    }

    // Load images
    this.loadImages();
    this.updateDisplay();
    this.updateButtonText();
  }

  private loadImages(): void {
    const diffContainer = this.overlay?.querySelector('#diff-container') as HTMLDivElement;
    const expectedContainer = this.overlay?.querySelector('#expected-container') as HTMLDivElement;

    if (diffContainer && this.state.diffImagePath) {
      // Convert file path to URL - assume the results are served from the project root
      const diffUrl = this.convertPathToUrl(this.state.diffImagePath);
      diffContainer.innerHTML = `
        <img src="${diffUrl}" 
             style="width: 100%; height: 100%; object-fit: contain;" 
             alt="Visual diff" />
      `;
    }

    if (expectedContainer && this.state.expectedImagePath) {
      // Convert file path to URL - assume the results are served from the project root
      const expectedUrl = this.convertPathToUrl(this.state.expectedImagePath);
      expectedContainer.innerHTML = `
        <img src="${expectedUrl}" 
             style="width: 100%; height: 100%; object-fit: contain;" 
             alt="Expected snapshot" />
      `;
    }
  }

  private convertPathToUrl(filePath: string): string {
    // Convert absolute file path to relative URL
    // Example: "/Users/.../visual-regression/results/.../story-diff.png"
    // -> "visual-regression/results/.../story-diff.png"

    // Find the visual-regression directory in the path
    const visualRegressionIndex = filePath.indexOf('visual-regression');
    if (visualRegressionIndex !== -1) {
      return filePath.substring(visualRegressionIndex);
    }

    // Fallback: return the path as-is
    return filePath;
  }

  public hide(): void {
    this.state.isVisible = false;

    if (this.overlay) {
      this.overlay.style.display = 'none';
    }

    if (this.controls) {
      this.controls.style.display = 'none';
    }
  }

  public destroy(): void {
    if (this.overlay) {
      this.overlay.remove();
    }
    if (this.controls) {
      this.controls.remove();
    }
  }
}

// Initialize the diff overlay when the script loads
let diffOverlay: DiffOverlay | null = null;

if (typeof window !== 'undefined') {
  diffOverlay = new DiffOverlay();
}

export default diffOverlay;
