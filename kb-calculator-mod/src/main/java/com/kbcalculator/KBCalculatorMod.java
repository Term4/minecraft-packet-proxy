package com.kbcalculator;

import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.common.Mod.EventHandler;
import net.minecraftforge.fml.common.event.FMLInitializationEvent;
import net.minecraftforge.fml.common.event.FMLPreInitializationEvent;

@Mod(modid = KBCalculatorMod.MODID, name = "KB Calculator", version = "1.0.0", clientSideOnly = true)
public class KBCalculatorMod {
    public static final String MODID = "kbcalculator";

    @EventHandler
    public void preInit(FMLPreInitializationEvent event) {
        net.minecraftforge.client.ClientCommandHandler.instance().registerCommand(new CommandCalculateKB());
    }

    @EventHandler
    public void init(FMLInitializationEvent event) {
        net.minecraftforge.common.MinecraftForge.EVENT_BUS.register(new KnockbackDataHandler());
    }
}
