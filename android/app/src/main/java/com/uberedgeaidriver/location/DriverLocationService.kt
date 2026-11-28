package com.uberedgeaidriver.location

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority

class DriverLocationService : Service() {
  private val fusedLocationClient by lazy { LocationServices.getFusedLocationProviderClient(this) }
  private val locationCallback = object : LocationCallback() {
    override fun onLocationResult(result: LocationResult) {
      result.lastLocation?.let { location ->
        sendBroadcast(Intent(ACTION_LOCATION).apply {
          setPackage(packageName)
          putExtra(EXTRA_LATITUDE, location.latitude)
          putExtra(EXTRA_LONGITUDE, location.longitude)
          putExtra(EXTRA_ACCURACY, location.accuracy)
          putExtra(EXTRA_TIMESTAMP, location.time)
          if (location.hasBearing()) putExtra(EXTRA_BEARING, location.bearing)
        })
      }
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopTracking()
      stopSelf()
      return START_NOT_STICKY
    }
    startInForeground()
    beginLocationUpdates()
    return START_NOT_STICKY
  }

  private fun startInForeground() {
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Driver location", NotificationManager.IMPORTANCE_LOW)
          .apply { description = "Shown while an active trip shares device location" },
      )
    }
    val openApp = packageManager.getLaunchIntentForPackage(packageName)
    val pendingIntent = openApp?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
    val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_menu_mylocation)
      .setContentTitle("Driver location is active")
      .setContentText("Collecting GPS for your active trip")
      .setOngoing(true)
      .setContentIntent(pendingIntent)
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun beginLocationUpdates() {
    val fine = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
    val coarse = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
    if (!fine && !coarse) {
      stopSelf()
      return
    }
    val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, UPDATE_INTERVAL_MS)
      .setMinUpdateIntervalMillis(MIN_UPDATE_INTERVAL_MS)
      .build()
    try {
      fusedLocationClient.requestLocationUpdates(request, locationCallback, mainLooper)
    } catch (_: SecurityException) {
      stopSelf()
    }
  }

  private fun stopTracking() {
    fusedLocationClient.removeLocationUpdates(locationCallback)
    stopForeground(STOP_FOREGROUND_REMOVE)
  }

  override fun onDestroy() {
    stopTracking()
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  companion object {
    const val ACTION_START = "com.uberedgeaidriver.location.START"
    const val ACTION_STOP = "com.uberedgeaidriver.location.STOP"
    const val ACTION_LOCATION = "com.uberedgeaidriver.location.FIX"
    const val EXTRA_LATITUDE = "latitude"
    const val EXTRA_LONGITUDE = "longitude"
    const val EXTRA_ACCURACY = "accuracy"
    const val EXTRA_TIMESTAMP = "timestamp"
    const val EXTRA_BEARING = "bearing"
    private const val CHANNEL_ID = "driver_location"
    private const val NOTIFICATION_ID = 4102
    private const val UPDATE_INTERVAL_MS = 2_000L
    private const val MIN_UPDATE_INTERVAL_MS = 1_000L
  }
}
