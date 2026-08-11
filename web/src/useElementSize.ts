import { useLayoutEffect, useRef, useState } from "react";

export interface ElementSize {
  width: number;
  height: number;
}

export function useElementSize<T extends HTMLElement>() {
  const element = useRef<T>(null);
  const [size, setSize] = useState<ElementSize>({ width: 1, height: 1 });

  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const measure = () => {
      const bounds = node.getBoundingClientRect();
      setSize({
        width: Math.max(1, Math.round(bounds.width)),
        height: Math.max(1, Math.round(bounds.height)),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return [element, size] as const;
}

