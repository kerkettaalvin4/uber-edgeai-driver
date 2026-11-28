package com.uberedgeaidriver.location

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

class DriverLocationModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private var listenerCount = 0
  private val locationReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      if (intent?.action != DriverLocationService.ACTION_LOCATION) return
      val payload = Arguments.createMap().apply {
        putDouble("latitude", intent.getDoubleExtra(DriverLocationService.EXTRA_LATITUDE, 0.0))
        putDouble("longitude", intent.getDoubleExtra(DriverLocationService.EXTRA_LONGITUDE, 0.0))
        putDouble("accuracyM", intent.getFloatExtra(DriverLocationService.EXTRA_ACCURACY, 0f).toDouble())
        putDouble("timestampMs", intent.getLongExtra(DriverLocationService.EXTRA_TIMESTAMP, 0L).toDouble())
        if (intent.hasExtra(DriverLocationService.EXTRA_BEARING)) {
          putDouble("bearingDeg", intent.getFloatExtra(DriverLocationService.EXTRA_BEARING, 0f).toDouble())
        }
      }
      reactApplicationContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(EVENT_LOCATION, payload)
    }
  }

  override fun getName() = "DriverLocation"

  override fun initialize() {
    super.initialize()
    val filter = IntentFilter(DriverLocationService.ACTION_LOCATION)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      reactApplicationContext.registerReceiver(locationReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      @Suppress("DEPRECATION")
      reactApplicationContext.registerReceiver(locationReceiver, filter)
    }
  }

  override fun invalidate() {
    try {
      reactApplicationContext.unregisterReceiver(locationReceiver)
    } catch (_: IllegalArgumentException) {
      // The receiver is already gone during application teardown.
    }
    super.invalidate()
  }

  @ReactMethod
  fun startTracking(promise: Promise) {
    val fineGranted = ContextCompat.checkSelfPermission(reactApplicationContext, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
    val coarseGranted = ContextCompat.checkSelfPermission(reactApplicationContext, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
    if (!fineGranted && !coarseGranted) {
      promise.reject("LOCATION_PERMISSION_REQUIRED", "Grant location permission before starting GPS tracking.")
      return
    }
    try {
      val intent = Intent(reactApplicationContext, DriverLocationService::class.java)
        .setAction(DriverLocationService.ACTION_START)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) reactApplicationContext.startForegroundService(intent)
      else reactApplicationContext.startService(intent)
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("LOCATION_START_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun stopTracking(promise: Promise) {
    try {
      reactApplicationContext.startService(
        Intent(reactApplicationContext, DriverLocationService::class.java)
          .setAction(DriverLocationService.ACTION_STOP),
      )
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("LOCATION_STOP_FAILED", error.message, error)
    }
  }

  @ReactMethod fun addListener(eventName: String) { listenerCount += 1 }
  @ReactMethod fun removeListeners(count: Int) { listenerCount = (listenerCount - count).coerceAtLeast(0) }

  companion object {
    const val EVENT_LOCATION = "driverLocation"
  }
}
