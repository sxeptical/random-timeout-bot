// Slash command definitions for Discord
export const commands = [
  {
    name: "roll",
    description: "Roll the dice and randomly timeout someone!",
  },
  {
    name: "rollcd",
    description:
      "Enable or disable the /roll command cooldown (admin/owner only)",
    options: [
      {
        name: "enabled",
        description: "Enable cooldown? (true/false)",
        type: 5, // BOOLEAN
        required: true,
      },
    ],
  },
  {
    name: "lb",
    description: "Show the leaderboard of who got exploded the most",
    options: [
      {
        name: "type",
        description: "Leaderboard type (xp or explosions)",
        type: 3, // STRING
        required: false,
        choices: [
          { name: "XP / Level", value: "xp" },
          { name: "Explosions", value: "explosions" },
        ],
      },
      {
        name: "page",
        description: "Page number to view (default 1)",
        type: 4, // INTEGER
        required: false,
      },
    ],
  },
  {
    name: "spin",
    description:
      "Spin the wheel! 50/50 chance for 1 week admin or 1 week timeout (5 spins/month)",
  },
  {
    name: "blackjack",
    description: "Play blackjack and gamble your explosion count!",
    options: [
      {
        name: "bet",
        description: "Amount to bet (number or 'all')",
        type: 3, // STRING
        required: true,
      },
    ],
  },
  {
    name: "xp",
    description: "View or change a user's xp / explosions.",
    options: [
      {
        name: "type",
        description: "What to modify (xp or explosions)",
        type: 3, // STRING
        required: true,
        choices: [
          { name: "XP", value: "xp" },
          { name: "Explosions", value: "explosions" },
        ],
      },
      {
        name: "username",
        description:
          "The username of the user that you'd like to view / edit.",
        type: 6, // USER
        required: false,
      },
      {
        name: "action",
        description: "add / remove / set",
        type: 3, // STRING
        required: false,
        choices: [
          { name: "add", value: "add" },
          { name: "remove", value: "remove" },
          { name: "set", value: "set" },
        ],
      },
      {
        name: "value",
        description: "Amount of explosions.",
        type: 4, // INTEGER
        required: false,
      },
    ],
  },
  {
    name: "roulette",
    description: "Play roulette with your explosions!",
    options: [
      {
        name: "bet",
        description: "Amount to bet (number or 'all')",
        type: 3, // STRING
        required: true,
      },
      {
        name: "space",
        description: "The space to bet on",
        type: 3, // STRING
        required: true,
        autocomplete: true,
      },
    ],
  },
];

// Roulette autocomplete choices
export const rouletteAutocompleteChoices = [
  "Red",
  "Black",
  "Even",
  "Odd",
  "1-18",
  "19-36",
  "1st 12",
  "2nd 12",
  "3rd 12",
  "0",
  // Numbers 1-36 are added dynamically
];

export function getRouletteAutocompleteResponse(focusedValue) {
  const choices = [...rouletteAutocompleteChoices];
  // Add numbers 1-36
  for (let i = 1; i <= 36; i++) choices.push(i.toString());

  const filtered = choices.filter((choice) =>
    choice.toLowerCase().startsWith(focusedValue.toLowerCase()),
  );

  // Limit to 25 choices
  return filtered.slice(0, 25).map((choice) => {
    let name = choice;
    // Add odds info to name for clarity
    if (["Red", "Black", "Even", "Odd", "1-18", "19-36"].includes(choice))
      name += " (1:1)";
    else if (["1st 12", "2nd 12", "3rd 12"].includes(choice)) name += " (2:1)";
    else name += " (35:1)"; // Numbers

    // Map display name to internal value
    let value = choice.toLowerCase();
    if (choice === "1st 12") value = "1-12";
    else if (choice === "2nd 12") value = "13-24";
    else if (choice === "3rd 12") value = "25-36";

    return { name, value };
  });
}
