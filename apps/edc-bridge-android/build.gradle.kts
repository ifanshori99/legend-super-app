buildscript {
    dependencies {
        // AGP 9 built-in Kotlin: pin the compiler to the Kotlin version the
        // libraries below were built with (their metadata is 2.4).
        classpath(libs.kotlin.gradle.plugin)
    }
}

plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.ksp) apply false
    alias(libs.plugins.room) apply false
}
