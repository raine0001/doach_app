import 'dart:io';
import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart'; // add path_provider if needed
import 'package:webview_flutter/webview_flutter.dart';
import 'arcmm_server.dart';

class ArcMmPage extends StatefulWidget {
  const ArcMmPage({super.key});
  @override
  State<ArcMmPage> createState() => _ArcMmPageState();
}

class _ArcMmPageState extends State<ArcMmPage> {
  ArcMmServer? _server;
  WebViewController? _controller;

  @override
  void initState() {
    super.initState();
    _boot();
  }

  Future<Directory> _resolveSessionRoot() async {
    // TODO: point this at your real session root
    // If your app already saves to /session under app docs:
    final docs = await getApplicationDocumentsDirectory();
    return Directory(p.join(docs.path, 'session'));

    // If you save to external storage, do that instead:
    // final ext = await getExternalStorageDirectory();
    // return Directory(p.join(ext!.path, 'Doach', 'session'));
  }

  Future<void> _boot() async {
    final root = await _resolveSessionRoot();
    _server = ArcMmServer(root);
    await _server!.start();

    final c = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(Colors.black)
      ..loadRequest(Uri.parse('http://127.0.0.1:${_server!.port}/arc_mm.html'));
    setState(() => _controller = c);
  }

  @override
  void dispose() {
    _server?.stop();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Arc & Make/Miss')),
      body: _controller == null
          ? const Center(child: CircularProgressIndicator())
          : WebViewWidget(controller: _controller!),
    );
  }
}
