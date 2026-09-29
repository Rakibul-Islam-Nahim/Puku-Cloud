provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}

resource "google_compute_network" "pukucloud" {
  name                    = "pukucloud-single-node"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "agent" {
  name          = "pukucloud-single-node"
  ip_cidr_range = "10.43.0.0/24"
  network       = google_compute_network.pukucloud.id
  region        = var.region
}

resource "google_compute_firewall" "ssh" {
  name    = "pukucloud-agent-ssh"
  network = google_compute_network.pukucloud.name

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = [var.ssh_allowed_cidr]
  target_tags   = ["pukucloud-agent"]
}

resource "google_compute_firewall" "egress" {
  name      = "pukucloud-agent-egress"
  network   = google_compute_network.pukucloud.name
  direction = "EGRESS"

  allow {
    protocol = "all"
  }

  destination_ranges = ["0.0.0.0/0"]
  target_tags        = ["pukucloud-agent"]
}

locals {
  startup_script = templatefile("${path.module}/startup-script.sh.tftpl", {
    control_plane_url = var.control_plane_url
    node_token        = var.node_token
  })
}

resource "google_compute_instance" "agent" {
  name         = "pukucloud-agent-single-node"
  machine_type = var.instance_type
  zone         = var.zone
  tags         = ["pukucloud-agent"]

  min_cpu_platform = "Intel Cascade Lake"

  advanced_machine_features {
    enable_nested_virtualization = true
  }

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2204-lts"
      size  = 100
      type  = "pd-balanced"
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.agent.id

    access_config {}
  }

  metadata = {
    enable-oslogin = "TRUE"
  }

  metadata_startup_script = local.startup_script

  service_account {
    scopes = ["https://www.googleapis.com/auth/logging.write", "https://www.googleapis.com/auth/monitoring.write"]
  }
}
