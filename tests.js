function blockThread(milliseconds) {
  const start = Date.now();
  while (Date.now() - start < milliseconds) {
    // Busy-wait (do nothing)
  }
}

async function testBufferAllocation(device, totalSize, buf=null) {

  // ✅ Step 1: Allocate the large GPU buffer (storage only)
  let buffer = buf;
  let bufSize = buffer ? (buffer.size / (1024*1024)) : (totalSize / (1024 * 1024));
  console.log(`🚀 Attempting to allocate ${bufSize} MB in GPU memory...`);
  if (!buffer) {
    buffer = device.createBuffer({
        size: totalSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, // No MAP_READ!
    });
  }

  if (!buffer) {
      console.error("❌ GPU Buffer allocation failed: Buffer object is null.");
      return null;
  }

  // ✅ Step 2: Allocate a small validation buffer (for reading back data)
  let validationBuffer = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, // Only allowed flags
  });

  if (!validationBuffer) {
      console.error("❌ Validation buffer allocation failed.");
      return null;
  }

  // ✅ Step 3: Write test data to the GPU buffer
  const testData = new Uint32Array([0xDEADBEEF]); // Test pattern
  device.queue.writeBuffer(buffer, 0, testData);

  // ✅ Step 4: Copy a small part of the buffer to validationBuffer (triggers allocation)
  let encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(buffer, 0, validationBuffer, 0, 4);
  device.queue.submit([encoder.finish()]); // Submitting forces execution

  // ✅ Step 5: Read back the value
  await validationBuffer.mapAsync(GPUMapMode.READ);
  const arrayBuffer = validationBuffer.getMappedRange();
  const result = new Uint32Array(arrayBuffer);

  // ✅ Step 6: Validate allocation
  if (result[0] === 0xDEADBEEF) {
      console.log(`✅ Successfully allocated and verified ${bufSize} MB GPU buffer.`);
      validationBuffer.unmap();
      return buffer;
  } else {
      //console.error(`❌ Allocation test failed! GPU buffer ${totalSize / (1024 * 1024)} MB may not be valid.`);
      throw new Error(`❌ Allocation test failed! GPU buffer ${bufSize} MB may not be valid.`);
      validationBuffer.unmap();
      return null;
  }
}

async function testGPUAllocation(size, device) {
    let bufferSize = size * 1024 * 1024;
    let buffer = await testBufferAllocation(device, bufferSize);
    if (!buffer) {
        console.log("⚠️ Buffer allocation was silently rejected by WebGPU!");
    }
    return buffer;
}

async function testTokenizer(progress) {
  try {
    progress(progress.total*0.1, "Loading tokenizer:");
    const wasmResponse = await fetch(`${window.MODEL_BASE_URL}/tiktoken_bg.wasm`);
    progress(progress.total*0.1, "Loading tokenizer:");
    const wasmBytes = await wasmResponse.arrayBuffer();
    await tiktokenReady;
    await window.tiktokenInit((imports) => WebAssembly.instantiate(wasmBytes, imports));
    progress(progress.total*0.1, "Loading tokenizer:");

    tokenizer = await createTokenizer(`${window.MODEL_BASE_URL}/llama3-2.tiktoken`);
    const tokenizer_works = (new TextDecoder().decode(tokenizer.decode(tokenizer.encode("hello world"))) === "hello world");
    console.log("tokenizer works:", tokenizer_works)
    progress(progress.total*0.1, `Tokenizer validated: ${tokenizer_works}`);
  } catch (error) {progress(-1, `Error launching tokenizer: ${error}`); console.log(error); return;}
}

async function runTest(test, progress, device) {
  if (test === "GPU_MEMORY") {
    let tot = 0;
    let allocs = [128, 128, 128, 128, 128, 128, 256, 256, 256, 256, 256, 256, 256, 256, 256, 256, 256, 256, 256, 256, 256, 256, 256, 256, 256, 256];
    let bufs = []
    for (const s of allocs) {
      blockThread(500);
      const buf = await testGPUAllocation(s, device);
      bufs.push(buf)
      tot += s;
      progress(-1, `${tot} MB allocated to gpu`);
    }
    progress(-1, `${tot} MB allocated to gpu, done allocating`);
    return;
  }
  else if (test === "TOUCH_MODEL") {
    // TODO update buffer flags, doesn't work atm
    let tot = 0;
    const response = await fetch(`${window.MODEL_BASE_URL}/net_metadata.json`);
    const data = await response.json();
    const state_dict = data.metadata.state_dict;
    await kernelsReady;
    const model = await transformer().setup(device, state_dict, progress);
    for (const [k,v] of Object.entries(state_dict)) {
      if (v.bytes) {
        await testBufferAllocation(device, null, v.bytes);
        tot += v.bytes.size;
        progress(-1, `${tot} allocated to gpu`);
      }
    }
    progress(-1, `${tot} allocated to gpu, done allocating`);
    return;
  }
  else if (test === "BROWSER_MEMORY") {
    const num_allocs = 1000;
    const bufs = [];
    const size = 47;
    const sizeBytes = size * 1024 * 1024;
    for (let i = 0; i < num_allocs; i++) {
      const buffer = new Uint8Array(sizeBytes);
      buffer.fill(1);
      bufs.push(buffer);
      progress(-1, `${size * bufs.length} MiB allocated in browser`);
      await new Promise(resolve => setTimeout(resolve, 0));
      blockThread(200);
    }
    progress(-1, `${size * bufs.length} MB allocated in browser, done allocating`);
    return;
  }
  else if (test === "MAXBUF") {
    const maxSize = 2048;
    for (let size = 0; size <= maxSize; size += 64) {
      const sizeBytes = size * 1024 * 1024;
      const buffer = new Uint8Array(sizeBytes);
      buffer.fill(255);
      progress(-1, `${size} MB buffer allocated`);
      await new Promise(resolve => setTimeout(resolve, 0));
      blockThread(300);
    }
    return;
  }
  else if (test === "MULTI_BIGBUF") {
    const size = 512;
    const sizeBytes = size * 1024 * 1024;
    const bufs = [];
    const num_allocs = 10;
    for (let i = 0; i < num_allocs; i++) {
      const buffer = new Uint8Array(sizeBytes);
      buffer.fill(255);
      bufs.push(buffer);
      progress(-1, `${bufs.length} x ${size}MB bufs allocated`);
      await new Promise(resolve => setTimeout(resolve, 0));
      blockThread(1000);
    }
    progress(-1, `${size * bufs.length} MB allocated in browser, done allocating`);
    return;
  }
  else if (test === "TOK") {
    await testTokenizer(progress);
    return;
  }
  else if (test === "WASM_MEMORY") {
    const memories = [];
    let tot = 0;
    for (let i=0; i<149; i++) {// 7003 MiB
      const mem = new WebAssembly.Memory({initial: 752, maximum: 752}); // 47 MiB
      const buf = new Uint8Array(mem.buffer);
      buf.fill(1);
      memories.push(buf);
      tot += 47;
      progress(-1, `${tot} MiB WebAssembly.Memory`);
      await new Promise(resolve => setTimeout(resolve, 0));
      blockThread(200);
    }
    return;
  }
  else if (test === "WASM_SIZE") {
    for (let i=1; i<110; i++) {// 7040 MiB
      const mem = new WebAssembly.Memory({initial: i * 1024, maximum: i * 1024}); // 47 MiB
      const buf = new Uint8Array(mem.buffer);
      buf.fill(1);
      progress(-1, `${i * 64} MiB WebAssembly.Memory`);
      await new Promise(resolve => setTimeout(resolve, 0));
      blockThread(400);
    }
    return;
  }
  else if (test === "IS_MOBILE") {
    const a = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const b = window.matchMedia("(max-width: 768px)").matches;
    const c = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    const isMobile = a || b || c;
    progress(-1, `${a} ${b} ${c}: ${isMobile}`);
    return;
  }
}