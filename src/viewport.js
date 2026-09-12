export function makeTransform(view) {
  return {
    toScreen: (p) => ({ x: p.x * view.scale + view.tx, y: p.y * view.scale + view.ty }),
    toImage: (p) => ({ x: (p.x - view.tx) / view.scale, y: (p.y - view.ty) / view.scale }),
    lengthToScreen: (px) => px * view.scale,
    lengthToImage: (screenPx) => screenPx / view.scale,
  };
}

export function fitView(imageWidth, imageHeight, canvasWidth, canvasHeight, padding = 24) {
  if (!imageWidth || !imageHeight || !canvasWidth || !canvasHeight) {
    return { scale: 1, tx: 0, ty: 0 };
  }
  const usableWidth = Math.max(1, canvasWidth - padding * 2);
  const usableHeight = Math.max(1, canvasHeight - padding * 2);
  const scale = Math.min(usableWidth / imageWidth, usableHeight / imageHeight);
  const tx = (canvasWidth - imageWidth * scale) / 2;
  const ty = (canvasHeight - imageHeight * scale) / 2;
  return { scale, tx, ty };
}

export function zoomAt(view, screenPoint, factor) {
  const scale = Math.max(0.02, Math.min(80, view.scale * factor));
  const imageX = (screenPoint.x - view.tx) / view.scale;
  const imageY = (screenPoint.y - view.ty) / view.scale;
  return {
    scale,
    tx: screenPoint.x - imageX * scale,
    ty: screenPoint.y - imageY * scale,
  };
}
