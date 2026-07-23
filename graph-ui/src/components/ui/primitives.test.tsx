import { fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Badge } from "./badge";
import { Button } from "./button";
import { Checkbox } from "./checkbox";
import { ScrollArea } from "./scroll-area";
import { Separator } from "./separator";

describe("Ariad UI primitive contracts", () => {
  it("preserves Button semantics, focus, keyboard activation, and asChild composition", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const { getByRole, rerender } = render(
      <Button variant="outline" size="sm" onClick={onClick}>
        Run audit
      </Button>,
    );

    const button = getByRole("button", { name: "Run audit" });
    button.focus();
    expect(button).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(button).toHaveAttribute("data-slot", "button");
    expect(button).toHaveAttribute("data-variant", "outline");
    expect(button).toHaveAttribute("data-size", "sm");

    rerender(
      <Button asChild variant="link">
        <a href="#details">Open details</a>
      </Button>,
    );
    const link = getByRole("link", { name: "Open details" });
    expect(link).toHaveAttribute("href", "#details");
    expect(link).toHaveAttribute("data-slot", "button");
    expect(link).toHaveAttribute("data-variant", "link");
  });

  it("preserves Badge output and asChild attributes", () => {
    const { getByText, rerender } = render(
      <Badge variant="secondary">Indexed</Badge>,
    );

    expect(getByText("Indexed").tagName).toBe("SPAN");
    expect(getByText("Indexed")).toHaveAttribute("data-variant", "secondary");

    rerender(
      <Badge asChild variant="outline">
        <a href="#status">Healthy</a>
      </Badge>,
    );
    const link = getByText("Healthy");
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "#status");
    expect(link).toHaveAttribute("data-slot", "badge");
  });

  it("preserves Checkbox focus, keyboard toggling, state, and disabled behavior", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    const { getByRole, rerender } = render(
      <Checkbox aria-label="Include tests" onCheckedChange={onCheckedChange} />,
    );

    const checkbox = getByRole("checkbox", { name: "Include tests" });
    await user.tab();
    expect(checkbox).toHaveFocus();
    await user.keyboard("[Space]");
    expect(onCheckedChange).toHaveBeenLastCalledWith(true);
    expect(checkbox).toHaveAttribute("aria-checked", "true");
    expect(checkbox).toHaveAttribute("data-state", "checked");

    rerender(<Checkbox aria-label="Include tests" disabled />);
    expect(getByRole("checkbox", { name: "Include tests" })).toBeDisabled();
  });

  it("does not leak programmatic form-state synchronization to ancestor clicks", () => {
    const ancestorClick = vi.fn();
    const renderCheckbox = (checked: boolean) => (
      <div onClick={ancestorClick}>
        <form>
          <Checkbox
            aria-label="Select all"
            checked={checked}
            onCheckedChange={() => {}}
          />
        </form>
      </div>
    );
    const { rerender } = render(renderCheckbox(false));

    rerender(renderCheckbox(true));

    expect(ancestorClick).not.toHaveBeenCalled();
  });

  it("preserves ScrollArea structure, accessible naming, children, and orientation", () => {
    const { container, getByText } = render(
      <ScrollArea aria-label="Architecture tree" type="always">
        <p>src/components</p>
      </ScrollArea>,
    );

    const root = container.querySelector('[data-slot="scroll-area"]');
    const viewport = container.querySelector('[data-slot="scroll-area-viewport"]');
    const scrollbar = container.querySelector('[data-slot="scroll-area-scrollbar"]');
    expect(root).toBeInTheDocument();
    expect(root).toHaveAttribute("aria-label", "Architecture tree");
    expect(viewport).toBeInTheDocument();
    expect(scrollbar).toHaveAttribute("data-orientation", "vertical");
    expect(
      container.querySelector("[data-radix-scroll-area-corner]"),
    ).not.toBeInTheDocument();
    expect(getByText("src/components")).toBeInTheDocument();
  });

  it("preserves decorative and semantic Separator accessibility", () => {
    const { container, rerender, getByRole } = render(<Separator />);
    expect(container.querySelector('[data-slot="separator"]')).toHaveAttribute(
      "role",
      "none",
    );

    rerender(<Separator decorative={false} orientation="vertical" />);
    const separator = getByRole("separator");
    expect(separator).toHaveAttribute("aria-orientation", "vertical");
    expect(separator).toHaveAttribute("data-orientation", "vertical");
  });

  it("keeps click propagation for direct user interaction", () => {
    const ancestorClick = vi.fn();
    const { getByRole } = render(
      <div onClick={ancestorClick}>
        <Checkbox aria-label="Interactive checkbox" />
      </div>,
    );

    fireEvent.click(getByRole("checkbox", { name: "Interactive checkbox" }));

    expect(ancestorClick).toHaveBeenCalledTimes(1);
  });
});
