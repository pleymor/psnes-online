# Compiler les shaders pour de vrai

`npm run test:ui` compte 1234 assertions et pas une seule ne compile un shader.
Elles vérifient l'arithmétique AUTOUR du rendu - les décalages, les masques,
les profondeurs - parce que c'est tout ce qui se teste sans GPU.

Un shader qui ne compile pas ne casse donc rien ici. Il donne un écran noir
dans le casque, à distance, sans message : la pire forme d'échec.

    node tools/glsl-compile/compile.mjs frontend/src/lib/vr/picture-filter.ts

Chromium en SwiftShader, un contexte WebGL2, et le préfixe GLSL3 que three met
devant tout `ShaderMaterial`. Rend la liste des uniformes ACTIFS, ce qui dit en
prime si une branche a été éliminée comme morte - un uniforme absent de la
liste n'est lu par personne.

Le préfixe est une reconstitution, pas le vrai : il reproduit ce dont ces
shaders-ci ont besoin (`texture2D`, `gl_FragColor`, `varying`,
`colorspace_fragment`). Il attrape les fautes de syntaxe, les types et les
surcharges - pas une divergence avec three elle-même.
