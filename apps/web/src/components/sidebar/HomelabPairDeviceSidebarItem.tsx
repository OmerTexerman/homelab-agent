/**
 * Sidebar footer "Pair a device" button, rendered by upstream's
 * `SidebarUtilityMenu` with one line. Shown only to admin sessions on web.
 */
import { QrCodeIcon } from "lucide-react";

import { openPairDeviceDialog, useCanPairDevices } from "../homelab/PairDeviceDialog";
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function HomelabPairDeviceSidebarItem() {
  const canPairDevices = useCanPairDevices();
  const { isMobile, setOpenMobile } = useSidebar();
  if (!canPairDevices) return null;
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label="Pair a device"
              onClick={() => {
                if (isMobile) setOpenMobile(false);
                openPairDeviceDialog();
              }}
              size="icon"
            >
              <QrCodeIcon />
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">Pair a device</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}
