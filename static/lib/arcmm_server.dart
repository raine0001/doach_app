// lib/arcmm_server.dart
import 'dart:convert';
import 'dart:io';
import 'package:flutter/services.dart' show rootBundle;
import 'package:mime/mime.dart';
import 'package:path/path.dart' as p;
import 'package:shelf/shelf.dart';
import 'package:shelf/shelf_io.dart';
import 'package:shelf_router/shelf_router.dart';

class ArcMmServer {
  final Directory sessionRoot; // e.g., Directory('/storage/emulated/0/Doach/session') or app docs/session
  HttpServer? _server;
  int? port;

  ArcMmServer(this.sessionRoot);

  Future<void> start() async {
    final router = Router();

    // ---- API: list sessions (most recent first) ----
    router.get('/api/arcmm/sessions', (Request req) async {
      if (!sessionRoot.existsSync()) return Response.ok(jsonEncode([]), headers: _json);
      final items = <Map<String, dynamic>>[];
      for (final entry in sessionRoot.listSync(followLinks: false)) {
        if (entry is! Directory) continue;
        final clipsDir = Directory(p.join(entry.path, 'clips'));
        if (!clipsDir.existsSync()) continue;
        final clips = clipsDir
            .listSync()
            .whereType<File>()
            .where((f) {
              final ext = p.extension(f.path).toLowerCase();
              return ext == '.webm' || ext == '.mebm' || ext == '.mp4';
            })
            .toList();
        if (clips.isEmpty) continue;
        final stat = await entry.stat();
        items.add({
          'id': p.basename(entry.path),
          'title': p.basename(entry.path),
          'mtime': stat.modified.millisecondsSinceEpoch / 1000,
          'count': clips.length
        });
      }
      items.sort((a, b) => (b['mtime'] as num).compareTo(a['mtime'] as num));
      return Response.ok(jsonEncode(items.take(50).toList()), headers: _json);
    });

    // ---- API: list shots for a session ----
    router.get('/api/arcmm/sessions/<sid>/shots', (Request req, String sid) async {
      final clipsDir = Directory(p.join(sessionRoot.path, sid, 'clips'));
      if (!clipsDir.existsSync()) return Response.ok(jsonEncode([]), headers: _json);
      final shots = <Map<String, dynamic>>[];
      var idx = 0;
      final files = clipsDir
          .listSync()
          .whereType<File>()
          .where((f) {
            final ext = p.extension(f.path).toLowerCase();
            return ext == '.webm' || ext == '.mebm' || ext == '.mp4';
          })
          .toList()
        ..sort((a, b) => a.path.compareTo(b.path));
      for (final f in files) {
        idx++;
        final name = p.basename(f.path);
        shots.add({
          'id': '$sid-$idx',
          'name': name,
          'url': '/session/$sid/clips/$name'
        });
      }
      return Response.ok(jsonEncode(shots), headers: _json);
    });

    // ---- Serve a clip file (handles .mebm as webm) ----
    router.get('/session/<sid>/clips/<file|.*>', (Request req, String sid, String file) async {
      final full = File(p.join(sessionRoot.path, sid, 'clips', file));
      if (!full.existsSync()) return Response.notFound('nope');
      final ext = p.extension(full.path).toLowerCase();
      final mime = ext == '.mp4'
          ? 'video/mp4'
          : 'video/webm'; // treat .webm and .mebm as webm
      final stream = full.openRead();
      return Response.ok(stream, headers: {'content-type': mime});
    });

    // ---- Static assets from Flutter bundle ----
    router.get('/static/<path|.*>', (Request req, String path) async {
      final assetPath = 'assets/arc_mm/$path';
      try {
        final data = await rootBundle.load(assetPath);
        final bytes = data.buffer.asUint8List();
        final ctype = _contentTypeFor(path);
        return Response.ok(bytes, headers: {'content-type': ctype});
      } catch (_) {
        return Response.notFound('missing asset $path');
      }
    });

    // ---- arc_mm.html root ----
    router.get('/arc_mm.html', (Request req) async {
      final data = await rootBundle.load('assets/arc_mm/arc_mm.html');
      final bytes = data.buffer.asUint8List();
      return Response.ok(bytes, headers: {'content-type': 'text/html; charset=utf-8'});
    });

    final handler = const Pipeline().addMiddleware(logRequests()).addHandler(router);
    _server = await serve(handler, InternetAddress.loopbackIPv4, 0);
    port = _server!.port;
    // print('ArcMM server on http://127.0.0.1:$port');
  }

  Future<void> stop() async {
    await _server?.close(force: true);
    _server = null;
    port = null;
  }
}

const _json = {'content-type': 'application/json; charset=utf-8'};

String _contentTypeFor(String path) {
  final guess = lookupMimeType(path);
  if (guess != null) return guess;
  final ext = p.extension(path).toLowerCase();
  if (ext == '.js') return 'application/javascript; charset=utf-8';
  if (ext == '.html') return 'text/html; charset=utf-8';
  return 'text/plain; charset=utf-8';
}
