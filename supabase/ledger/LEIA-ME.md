# `supabase/ledger/` — o que rodou em produção

Este diretório é **registro histórico**, não receita. Guarda o SQL que
efetivamente foi executado em produção, byte a byte, para auditoria.

## A única garantia que importa

**Nada aqui é executável por `supabase db push`, porque `db push` lê apenas
`supabase/migrations/*.sql`.** É isso que torna o ledger seguro — estar fora de
`supabase/migrations/`. Nenhuma outra propriedade deste diretório é proteção.

O nome com **dois underscores** (`20260911204433__nome.sql`) é:

* **convenção visual** — distingue ledger de migration numa listagem;
* **regra nossa de CI** — a catraca de migrations reprova arquivo `__` dentro de
  `supabase/migrations/`.

O `__` **não** é reconhecido pelo Supabase CLI e **não** protege nada por si.
Se um arquivo daqui for copiado para `supabase/migrations/`, o que impede o
estrago é a checagem do CI, não o nome.

## Estrutura

```
supabase/ledger/
├── LEIA-ME.md              este arquivo
├── DUAS-TRILHAS.md         a medição da distância entre repo e produção
└── YYYY-MM/
    ├── INDICE.tsv          version · nome · arquivo · md5 · bytes · data · tipo · revertida_por · nota
    ├── <version>__<nome>.sql          SQL exato, sem um comentário nosso
    └── <version>__NOTA.md             explicação, quando houver
```

## Regras do diretório

1. **O `.sql` é byte a byte igual aos `statements` de
   `supabase_migrations.schema_migrations`.** Nenhuma documentação entra nele —
   um comentário nosso muda o md5 e o md5 é justamente a prova de igualdade.
2. **Explicação vai em arquivo `__NOTA.md` ou `__INCIDENTE-*.md` ao lado.**
3. **`INDICE.tsv` é a fonte de verdade do diretório** e inclui versões que
   rodaram **sem** arquivo (execuções pontuais, sondas HTTP), com `arquivo = -`.
   Ledger incompleto é pior que ledger inexistente.
4. **O nome do arquivo usa o `name` que produção registrou**, não o nome que o
   arquivo tinha antes.

## Como reconferir um arquivo

```sql
select version, name, md5(array_to_string(statements, E'\n')) as md5_prod
  from supabase_migrations.schema_migrations
 where version = '20260911204433';
```

```bash
perl -0pe 's/\n\z//' supabase/ledger/2026-09/20260911204433__*.sql | md5 -q
```

O `perl` remove o newline final do arquivo antes do hash: os `statements` de
produção não o têm, e o arquivo tem por convenção POSIX.

**Cuidado com `bytes`.** A coluna `bytes` do `INDICE.tsv` é a contagem real de
bytes do arquivo. `length()` no Postgres conta **caracteres**, não bytes — em
arquivos com acento os dois números divergem legitimamente (ex.: `20260911205305`
tem 9.154 bytes e 9.145 caracteres). **O md5 é o critério; a contagem é
informativa.**

## Classificação em `tipo`

| Tipo | O que é | Pode ter par em `migrations/`? |
|---|---|---|
| `ESTRUTURAL` | cria ou altera tabela, função, gatilho, índice, política, permissão | sim |
| `ESTRUTURAL_REVERTIDA` | estrutural que foi desfeita por uma versão posterior | **não** |
| `CORRECAO_DADO` | `update`/`insert` em dados de produção | não |
| `EXECUCAO_PONTUAL` | rodou uma rotina para capturar resultado | não |
| `SONDA` | chamada HTTP, amostragem, diagnóstico | não |

## O projeto remoto deste checkout

Conferido em 12/09/2026, somente leitura:

* **projeto linked: `ahattpqrjmhkzsmnbdzs` — a PRODUÇÃO.** A referência fica em
  `supabase/.temp/linked-project.json`, que é o arquivo que o CLI grava no
  `supabase link`;
* `supabase/config.toml` tem `project_id = "edlzlfbstshojxrudwaa"`. **Esse campo
  não é o projeto remoto** — é o identificador do projeto local. Não serve como
  prova de destino de `db push`;
* ou seja: **um `db push` daqui vai para a produção.** Não existe proteção
  acidental por apontamento de staging. Enquanto não houver baseline validada,
  `db push` não deve ser executado neste checkout.
