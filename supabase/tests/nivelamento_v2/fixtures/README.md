# Fixture sintetico do export de definicoes

`prod_defs_sintetico.json` foi gerado a partir dos **stubs** de `01_ambiente.sql`, nao de producao.
Serve para validar o mecanismo (export -> verificacao por sha256 -> importacao -> checagem de hash no banco -> migration). **Nao** valida equivalencia com producao.
A validacao com definicoes reais continua PENDENTE ate existir `prod_defs.json` exportado de producao.
