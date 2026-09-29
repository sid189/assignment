import type { Database } from "./store/Database.js";
import type { Product } from "./domain/types.js";

export const seedProducts: Product[] = [
  { id: "p-mug", name: "Ceramic Mug", unitPriceCents: 1299, availableInventory: 100 },
  { id: "p-notebook", name: "Dotted Notebook", unitPriceCents: 899, availableInventory: 200 },
  { id: "p-pen", name: "Fountain Pen", unitPriceCents: 2499, availableInventory: 50 },
  { id: "p-tote", name: "Canvas Tote Bag", unitPriceCents: 1899, availableInventory: 75 },
  { id: "p-keychain", name: "Enamel Keychain", unitPriceCents: 599, availableInventory: 150 },
  // Deliberately scarce — the primary product concurrency tests race over.
  { id: "p-poster", name: "Limited Edition Poster", unitPriceCents: 3499, availableInventory: 3 },
  // A second, independently-scarce product — lets a single cart (or a
  // single race) hold two contested items at once, proving reservation
  // correctness doesn't cross-contaminate between products.
  { id: "p-scarf", name: "Wool Scarf", unitPriceCents: 4599, availableInventory: 2 },
  // Zero stock from the start — exercises the "already sold out" path
  // immediately (add-to-cart fails fast) without needing to first drain
  // another product's inventory via other requests.
  { id: "p-typewriter", name: "Vintage Typewriter", unitPriceCents: 12999, availableInventory: 0 },
];

export function seedDatabase(db: Database): void {
  db.exec((t) => {
    for (const product of seedProducts) {
      t.products.set(product.id, { ...product });
    }
  });
}
