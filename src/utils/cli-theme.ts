import chalk from "chalk";

export const amber = chalk.hex("#FFC107");
export const amberBold = chalk.hex("#FFC107").bold;

export const inquirerTheme = {
    prefix: { idle: amber("?"), done: chalk.green("✓") },
    icon: { cursor: amber("❯") },
    style: {
        highlight: (text: string) => amber(text),
        answer: (text: string) => amber(text),
    },
};
