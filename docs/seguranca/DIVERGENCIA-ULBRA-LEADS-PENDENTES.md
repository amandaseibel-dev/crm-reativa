# Divergência — ulbra-leads-pendentes (fora da republicação da #945)

- Produção (v5): consulta `usuarios` com `select("receptivo, gestao").limit(1).single()`, sem filtro por e-mail; depende da RLS.
- Repositório (`main`): outra versão, com correspondência por e-mail e portão próprio, marcada "SUPERADA ... NÃO USAR EM TELA NOVA".
- Decisão da gestão: a função fica FORA desta republicação. A v5 permanece em produção.
- Análise separada pendente: entender o uso real pela tela, a RLS que a v5 depende e o risco de identificação por consulta sem filtro.
