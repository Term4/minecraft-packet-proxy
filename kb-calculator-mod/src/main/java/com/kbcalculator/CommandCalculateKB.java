package com.kbcalculator;

import net.minecraft.client.Minecraft;
import net.minecraft.command.CommandBase;
import net.minecraft.command.CommandException;
import net.minecraft.command.ICommandSender;
import net.minecraft.util.ChatComponentText;
import net.minecraft.util.EnumChatFormatting;

import java.util.Collections;
import java.util.List;

public class CommandCalculateKB extends CommandBase {

    @Override
    public String getCommandName() {
        return "calculatekb";
    }

    @Override
    public String getCommandUsage(ICommandSender sender) {
        return "/calculatekb - Start knockback data collection. Play combat to gather data.";
    }

    @Override
    public List<String> getCommandAliases() {
        return Collections.singletonList("kbcalc");
    }

    @Override
    public int getRequiredPermissionLevel() {
        return 0; // Anyone can use
    }

    @Override
    public void processCommand(ICommandSender sender, String[] args) throws CommandException {
        if (Minecraft.getMinecraft().theWorld == null || Minecraft.getMinecraft().thePlayer == null) {
            sender.addChatMessage(new ChatComponentText(EnumChatFormatting.RED + "You must be in a world to use this command."));
            return;
        }

        KnockbackDataHandler handler = KnockbackDataHandler.INSTANCE;
        if (handler.isCollecting()) {
            handler.stopCollecting();
            sender.addChatMessage(new ChatComponentText(EnumChatFormatting.YELLOW + "Stopped knockback data collection."));
            return;
        }

        handler.startCollecting();
        sender.addChatMessage(new ChatComponentText(EnumChatFormatting.GREEN + "KB Calculator: Data collection started!"));
        sender.addChatMessage(new ChatComponentText(EnumChatFormatting.GRAY + "Play combat games normally. The mod will collect:"));
        sender.addChatMessage(new ChatComponentText(EnumChatFormatting.GRAY + "  - Normal hits (stand still, get hit)"));
        sender.addChatMessage(new ChatComponentText(EnumChatFormatting.GRAY + "  - Sprint hits (stand still, get sprint-hit)"));
        sender.addChatMessage(new ChatComponentText(EnumChatFormatting.GRAY + "  - Sprint hits while moving"));
        sender.addChatMessage(new ChatComponentText(EnumChatFormatting.GRAY + "  - Double hits (get hit twice quickly while opponent sprints)"));
        sender.addChatMessage(new ChatComponentText(EnumChatFormatting.GRAY + "When enough data is gathered, results will be exported automatically."));
        sender.addChatMessage(new ChatComponentText(EnumChatFormatting.GRAY + "Use /calculatekb again to stop early."));
    }
}
