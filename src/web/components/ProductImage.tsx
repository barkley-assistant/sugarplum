import { useState } from "react";

interface ProductImageProps {
  src: string;
  /** Decorative by default: the title already names the product. */
  alt?: string;
}

/** 56px thumbnail with preserved aspect (cover, never letterboxed), lazy,
 *  on a muted well. A failed load swaps to the well instead of a broken
 *  icon. Keeps the .item-thumb class for selector compatibility. */
export function ProductImage({ src, alt = "" }: ProductImageProps) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <span className="product-img-fallback" aria-hidden="true" />;
  }
  return (
    <img
      className="item-thumb product-img"
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
