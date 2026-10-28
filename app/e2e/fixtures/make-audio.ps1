# Synthetic speech for the e2e suite (Windows' built-in voice, 16 kHz mono 16-bit).
# Run from app/:  powershell -ExecutionPolicy Bypass -File e2e/fixtures/make-audio.ps1
# Synthetic voices only: no real interview audio is used by the tests.
Add-Type -AssemblyName System.Speech
$dir = Join-Path $PSScriptRoot 'audio'
New-Item -ItemType Directory -Force $dir | Out-Null
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, 'Sixteen', 'Mono')
$clips = [ordered]@{
  # §13 #1: 10 questions (q02, q04, q07 are split by a pause) and 5 non-questions
  'q01'  = 'Can you explain what dependency injection is, and why you would use it?'
  'q02a' = 'So when you design a public REST API'
  'q02b' = 'how do you handle versioning?'
  'q03'  = 'What is the difference between a process and a thread?'
  'q04a' = 'Tell me about a time'
  'q04b' = 'when you had to resolve a conflict in your team.'
  'q05'  = 'How does garbage collection work in dot net?'
  'q06'  = 'Walk me through how you would design a URL shortener.'
  'q07a' = 'Could you describe'
  'q07b' = 'how an index improves database query performance?'
  'q08'  = 'Why would you choose a message queue over direct HTTP calls?'
  'q09'  = 'Explain the CAP theorem in simple terms.'
  'q10'  = 'What are the main benefits of writing unit tests?'
  'n1'   = 'Okay, great.'
  'n2'   = 'Thank you, that makes sense.'
  'n3'   = 'I worked at a logistics company for three years before I joined this team.'
  'n4'   = 'Our team mostly deploys to Azure and Kubernetes.'
  'n5'   = 'Right, interesting.'
  # §13 #5: 8 short distinct questions
  'c1' = 'What is a closure?'
  'c2' = 'What is a deadlock?'
  'c3' = 'What is a mutex?'
  'c4' = 'What is recursion?'
  'c5' = 'What is a hash table?'
  'c6' = 'What is a binary tree?'
  'c7' = 'What is a race condition?'
  'c8' = 'What is memoization?'
  # short questions (3 words, under minWords 4) and a longer control
  's1' = 'What is polymorphism?'
  's2' = 'Define dependency injection.'
  's3' = 'What is polymorphism in object oriented programming?'
}
foreach ($k in $clips.Keys) {
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $s.Rate = 0
  $s.SetOutputToWaveFile((Join-Path $dir "$k.wav"), $fmt)
  $s.Speak($clips[$k])
  $s.Dispose()
}
"made $($clips.Count) clips in $dir"
