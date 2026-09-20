"use client"

import { useId, useState } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { isHexColor } from "@/lib/form-theme"

interface ColorFieldProps {
  id: string
  label: string
  value: string
  onValidChange: (value: string) => void
}

interface HexColorInputProps {
  id: string
  label: string
  errorId: string
  value: string
  onValidChange: (value: string) => void
}

function HexColorInput({
  id,
  label,
  errorId,
  value,
  onValidChange,
}: HexColorInputProps) {
  const [textValue, setTextValue] = useState(value)
  const invalid = !isHexColor(textValue)

  function update(nextValue: string) {
    setTextValue(nextValue)
    if (isHexColor(nextValue)) onValidChange(nextValue.toLowerCase())
  }

  return (
    <>
      <Input
        id={`${id}-hex`}
        value={textValue}
        onChange={(event) => update(event.target.value)}
        aria-label={`${label} hex`}
        aria-invalid={invalid}
        aria-describedby={invalid ? errorId : undefined}
        spellCheck={false}
        className="font-mono"
      />
      {invalid && (
        <p id={errorId} className="col-span-2 text-xs text-destructive">
          Use a six-digit hex color.
        </p>
      )}
    </>
  )
}

export function ColorField({
  id,
  label,
  value,
  onValidChange,
}: ColorFieldProps) {
  const generatedId = useId()
  const labelId = `${generatedId}-label`
  const errorId = `${generatedId}-error`

  return (
    <div className="space-y-2">
      <Label id={labelId} htmlFor={`${id}-hex`}>
        {label}
      </Label>
      <div className="grid grid-cols-[2.75rem_minmax(0,1fr)] items-center gap-2">
        <input
          id={id}
          type="color"
          value={value}
          onChange={(event) => onValidChange(event.target.value)}
          aria-labelledby={labelId}
          className="h-8 w-10 rounded-md border border-input bg-transparent p-1"
        />
        <HexColorInput
          key={value}
          id={id}
          label={label}
          errorId={errorId}
          value={value}
          onValidChange={onValidChange}
        />
      </div>
    </div>
  )
}
