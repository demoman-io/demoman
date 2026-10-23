// A serve script that fails at once, saying why on stderr.
process.stderr.write("fake studio: cannot bind anything today\n");
process.exit(3);
