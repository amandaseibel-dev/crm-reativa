---
description: Auditoria do diff atual contra as premissas e a premissa de segurança, com o bloco de conclusão preenchido — portão local antes do PR
---

Delegue ao subagente `guardiao` a auditoria do diff atual.

Contexto que ele precisa receber: a branch, a base de comparação e se a
alteração toca banco, tela, Prime/ULBRA ou permissão.

Exija do parecer: veredito na primeira linha, arquivo e seção citados para cada
regra invocada, e o bloco da §13 de
`docs/seguranca/PREMISSA_SEGURANCA_PROJETO.md` preenchido — campo não conferido
vai como `NÃO CONFERIDO`, nunca como ☑.

Este comando não corrige nada. Se houver reprovação, traga a lista e pergunte
ao usuário o que atacar primeiro.
