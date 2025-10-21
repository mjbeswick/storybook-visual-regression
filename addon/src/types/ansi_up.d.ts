declare module 'ansi_up' {
  export class AnsiUp {
    use_classes: boolean;
    ansi_to_html(text: string): string;
  }
}
