import type { Metadata } from "next";
import ArenaGame from "./game/ArenaGame";

export const metadata: Metadata = {
  title: { absolute: "Arcane Arena — Multiplayer spell duels" },
  description:
    "Enter a fast, original multiplayer arena built around expressive movement and elemental spell combat.",
};

export default function Home() {
  return <ArenaGame />;
}
