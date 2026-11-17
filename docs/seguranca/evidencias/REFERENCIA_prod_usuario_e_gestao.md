# Referência — evidência exata de `usuario_e_gestao()` (acesso restrito)

O arquivo SQL com o corpo exato da função em produção **não está neste repositório**. Ele foi retirado da entrega para não expor identificadores institucionais desnecessários.

- **Conteúdo preservado:** `CREATE OR REPLACE FUNCTION public.usuario_e_gestao()` tal como lido em produção (leitura somente, 16/11/2026).
- **SHA-256:** `83191ea84a90cc0e098d8d33da6179a9c7b6ab4a73c23b2113d4007fbabdb288`
- **Tamanho:** 321 bytes
- **Referência histórica:** a autorização anterior (`docs/seguranca/autorizacao-tabulacao-termo-fisico-20261114120000.md`, linha 31) cita este arquivo com este hash. O registro não foi alterado.
- **Local da cópia exata:** acesso restrito, na máquina da responsável pela #954 (`~/Library/Application Support/reativa-acesso-restrito/evidencias-termo/`, permissão 600). Verificada por SHA-256 em relação ao original.
- **Pendência:** não há destino de equipe com acesso restrito disponível nesta sessão. A gestão decide o destino definitivo (cofre, repositório privado ou outro) e informa ao registro.

Descrição do conteúdo, sem identificadores: a função compara o e-mail do JWT (`auth.jwt()->>'email'`, minúsculas) com uma lista fixa de três identificadores institucionais de gestão. Sem migration versionada; ver `catalogo_usuario_e_gestao_20261116.md`.
