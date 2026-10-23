-- Rollback de 20261023184500_modelos_email_rematricula_2027_1
--
-- A migration foi aplicada em producao em 2026-10-23 15:52:59 UTC e registrada
-- sob a versao 20261023155259 (apply_migration gera o proprio carimbo). Ver
-- supabase/ledger/2026-10/20261023155259__NOTA.md para a correspondencia entre
-- as duas versoes e a prova de que o SQL e o mesmo.
--
-- NAO FOI EXECUTADO.
--
-- PITR NAO esta habilitado neste projeto: rollback aqui nunca pode ser restore.
-- Por isso a reversao e por ID EXATO, com o estado de antes registrado no fim
-- deste arquivo.
--
-- ---------------------------------------------------------------------------
-- O QUE ESTE ROLLBACK PRESERVA
-- ---------------------------------------------------------------------------
--
-- 1. O HISTORICO DE ENVIO, por construcao. O envio e gravado em
--    `aluno_movimentacoes` como texto livre ("E-mail (<situacao>) enviado por
--    <operador>"), sem chave estrangeira, sem `template_id` e sem coluna
--    `chave` ligando as duas tabelas. Este arquivo nao menciona
--    `aluno_movimentacoes` em comando nenhum, e nem poderia afeta-la. As 171
--    linhas de "Reta final das rematriculas" seguem intactas depois dele.
--
-- 2. AS LINHAS DA TABELA. A parte 2 DESATIVA os dois modelos de 2027/1 em vez
--    de apagar: desativar reverte o efeito visivel -- eles saem das duas
--    portas de envio, individual e em lote, que leem `ativo = true` -- sem
--    destruir linha nenhuma. Se algum envio tiver sido feito com eles antes do
--    rollback, a linha de historico continua legivel porque nao depende da
--    linha do modelo existir.
--
-- 3. O TEXTO DE TODOS OS MODELOS. Nenhum `assunto`, `corpo_html` ou
--    `corpo_texto` e reescrito aqui. A unica coluna que muda e `ativo` (e
--    `novo`, nos dois novos).
--
-- O que este rollback NAO restaura, de proposito: a contagem de linhas volta
-- a 10, nao a 8. As duas linhas de 2027/1 permanecem, desativadas. Para
-- remocao completa existe o DELETE comentado no fim -- e ele tambem nao toca
-- historico.

do $$
begin
  if to_regclass('public.email_templates') is null then
    raise notice 'email_templates nao existe neste banco -- nada a reverter.';
    return;
  end if;

  -- 1) "Reta final das rematriculas" volta as opcoes ativas.
  --
  -- O `and chave = ...` e cinto e suspensorio: se o id 10 um dia for outra
  -- linha, isto vira no-op em vez de reativar o modelo errado.
  update public.email_templates
     set ativo = true
   where id = 10 and chave = 'reta_final_matricula';

  -- 2) Os dois de 2027/1 saem das opcoes de envio (individual e em lote).
  --    Por id E por chave, pelo mesmo motivo da parte 1.
  update public.email_templates
     set ativo = false, novo = false
   where (id = 13 and chave = 'rematricula_2027_1_vaga')
      or (id = 14 and chave = 'rematricula_2027_1_condicoes');
end $$;

-- Remocao completa -- SO se a gestao pedir explicitamente. Nao apaga
-- historico: ele e texto livre em aluno_movimentacoes e nao referencia
-- email_templates.
-- delete from public.email_templates
--  where id in (13, 14)
--    and chave in ('rematricula_2027_1_vaga', 'rematricula_2027_1_condicoes');

-- ---------------------------------------------------------------------------
-- ESTADO ANTES DA MIGRATION (producao, 2026-10-23, imediatamente antes)
-- ---------------------------------------------------------------------------
-- 8 linhas em email_templates. A migration mudou UMA (id 10: ativo true ->
-- false) e inseriu duas (ids 13 e 14). Nenhuma outra linha foi tocada, e os
-- md5 abaixo provam qual era o texto de cada uma.
--
--  id | chave                      | ordem | ativo | novo  | md5(assunto)
-- ----+----------------------------+-------+-------+-------+---------------------------------
--   5 | envio_acordo               |     1 | true  | false | 3e822c5ec39233485c88cb1486228561
--   6 | primeira_abordagem         |     2 | false | false | 64d8f2e43b3959a4d4e9f60ab4168489
--   7 | lembrete_pagamento         |     3 | true  | false | 8c61c3db4f38bbff7371c0c4bd4d51d9
--   8 | acordo_em_atraso           |     4 | true  | false | 143cb28ede1648f282cd90739e5d92a2
--   9 | acordo_quebrado            |     5 | true  | false | 5b794904112fd36c47528b18922795b3
--  10 | reta_final_matricula       |     6 | TRUE  | false | 18121e28202c21c15727773cc4a32bed
--  11 | aviso_mensalidades_aberto  |     2 | true  | false | e6d92a7a0c078b4105305e5f5abfb121
--  12 | novas_condicoes_negociacao |     0 | true  | TRUE  | 144e638e1fe94fa19f3bbf50602e21f4
--
-- md5(corpo_html) / md5(corpo_texto), na mesma ordem de id:
--   5  c42579e7b024a659326fcb0f78561a37 / a9cc3d0ec72d19e22c9f82fd8f361501
--   6  012637b8519d89de2590bb70b64639a7 / 16dc03919c3b1b17eb8023c038dafd12
--   7  822d36ff95b9bea13727eca4a25a0485 / c0542623feb7d92236f2cfb4e50cdea8
--   8  b267246ff58ec3e898993eb9d70a31d8 / d6599dbbd719036df92279c107fc1fe8
--   9  554813684cc4e15d13d2ae127d2c0b2d / a1201d5744bca00a6674f377c4eaffb4
--  10  cd48af0a8e2c72caf0aa67706077e8a0 / 0ca18c8cffe0227881bd37b9881be31e
--  11  b6d30ea2c8601cf730b4cc16dc9659fc / c1652aab990a585ff370dafa73e6add0
--  12  6a437f6485ec514d8e444e2de967c440 / d6e041697a073c1328ad00eab952874d
--
-- Impressao digital das 8 linhas juntas, antes:
--   md5(string_agg(chave|ativo|novo|ordem|md5(assunto)|md5(corpo_html)|md5(corpo_texto), E'\n' order by id))
--   = 461f83de936db53e9ba7ce06fd2c0c47
--
-- Depois da migration, o texto de "Reta final" (id 10) segue identico -- os
-- tres md5 da linha 10 acima foram reconferidos em producao apos a aplicacao e
-- bateram. Os outros 7 modelos tambem foram conferidos um a um: 7 de 7
-- inalterados em ordem, ativo, novo e nos tres md5.
--
-- Historico de envio de "Reta final das rematriculas": 171 linhas em
-- aluno_movimentacoes (tipo ACAO_MASSIVA_EXTERNA_EMAIL), 171 antes e 171
-- depois. Este rollback nao as toca.
