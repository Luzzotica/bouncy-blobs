import React, { useState } from "react";

interface GameButtonProps {
  onPress: (pressed: boolean) => void;
  label?: string;
  size?: number;
  color?: string;
}

export const GameButton: React.FC<GameButtonProps> = ({
  onPress,
  label = "",
  size = 100,
  color = "#10b981",
}) => {
  const [isPressed, setIsPressed] = useState(false);

  const handleStart = (e: React.TouchEvent | React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation(); // Prevent event from bubbling to joystick
    setIsPressed(true);
    onPress(true);
  };

  const handleEnd = (e: React.TouchEvent | React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation(); // Prevent event from bubbling to joystick
    setIsPressed(false);
    onPress(false);
  };

  return (
    <button
      onMouseDown={handleStart}
      onMouseUp={handleEnd}
      // onMouseLeave={handleEnd}
      onTouchStart={handleStart}
      onTouchEnd={handleEnd}
      className="rounded-full font-bold text-white touch-none select-none transition-all duration-100 active:scale-95"
      style={{
        width: size,
        height: size,
        backgroundColor: isPressed ? color : `${color}dd`,
        boxShadow: isPressed
          ? `inset 0 4px 8px rgba(0,0,0,0.3)`
          : `0 4px 12px rgba(0,0,0,0.3)`,
        border: "none",
        fontSize: size * 0.3,
      }}
    >
      {label}
    </button>
  );
};
