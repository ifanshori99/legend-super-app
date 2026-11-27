plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.ksp)
    alias(libs.plugins.room)
}

// Kunci rilis: di luar repo. Path dan password dari env var atau ~/.gradle/gradle.properties.
val releaseKeystorePath: String? =
    (System.getenv("LEGEND_EDC_KEYSTORE") ?: providers.gradleProperty("LEGEND_EDC_KEYSTORE").orNull)
        ?.takeIf { it.isNotBlank() }
val releaseKeystorePassword: String? =
    (System.getenv("LEGEND_EDC_KEYSTORE_PASSWORD") ?: providers.gradleProperty("LEGEND_EDC_KEYSTORE_PASSWORD").orNull)
        ?.takeIf { it.isNotBlank() }

android {
    namespace = "id.legend.edcbridge"
    compileSdk = 35

    defaultConfig {
        applicationId = "id.legend.edcbridge"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    signingConfigs {
        if (releaseKeystorePath != null && releaseKeystorePassword != null) {
            create("release") {
                storeFile = file(releaseKeystorePath)
                storePassword = releaseKeystorePassword
                keyAlias = "legend-edc-bridge"
                keyPassword = releaseKeystorePassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Tanpa kunci rilis: build gagal (lihat pemeriksaan di bawah), tidak ada jatuh ke kunci debug.
            signingConfigs.findByName("release")?.let { signingConfig = it }
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

room {
    schemaDirectory("$projectDir/schemas")
}

dependencies {
    implementation(libs.room.runtime)
    ksp(libs.room.compiler)
    implementation(libs.okhttp)
    implementation(libs.serialization.json)

    testImplementation(libs.junit)
}

// Build rilis wajib punya kunci: gagal jelas, bukan APK tanpa tanda tangan atau bertanda debug.
gradle.taskGraph.whenReady {
    val buildsRelease = allTasks.any { it.project == project && it.name.contains("Release") && it.name != "lintVitalAnalyzeRelease" }
    if (buildsRelease && (releaseKeystorePath == null || releaseKeystorePassword == null)) {
        throw GradleException(
            "Build rilis butuh kunci tanda tangan: set LEGEND_EDC_KEYSTORE dan LEGEND_EDC_KEYSTORE_PASSWORD " +
                "(env var atau ~/.gradle/gradle.properties). Gunakan scripts/build-release.sh.",
        )
    }
}
