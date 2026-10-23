-- BASE DE REFERENCIA DA TRIAGEM — a fotografia das 448 pendencias de
-- producao em 22/10/2026, reproduzida com dados 100% sinteticos.
--
-- O QUE ESTA BASE E, E O QUE ELA NAO E. Ela reproduz a DISTRIBUICAO medida em
-- producao: quantas pendencias por subcategoria e quanto dinheiro em cada uma.
-- Nenhum CPF, nome, matricula ou id real entra aqui -- os ids sao sequenciais e
-- os textos de motivo sao os MOLDES reais do motor com numeros inventados.
--
-- Por isso os testes que usam esta base provam que O CLASSIFICADOR reproduz a
-- particao declarada, nao que a producao tenha esses numeros hoje. A medicao em
-- producao esta registrada em docs/TRIAGEM-FILA-PAGAMENTO-2026-10-22.md, com as
-- consultas que a produziram.
--
-- ESTA BASE DEPENDE da bancada `fluxo_incremental_prod_20261021.sql`, carregada
-- antes: dela vem `pagamentos`, `fila_pagamento_sem_vinculo`,
-- `fluxo_pagamentos_config`, os papeis do Supabase, o stub de `auth.jwt()` e os
-- corpos de producao de `usuario_e_gestao()` e `_fila_pagamento_tentativa()`
-- (conferidos por md5). O que falta la e acrescentado aqui.

-- ---------------------------------------------------------------------------
-- O QUE A BANCADA DA RODADA NAO TEM. A bancada de 21/10 foi escrita para o
-- envelope da rodada e carrega so as colunas que ele usa. A triagem depende de
-- `sugestoes` (jsonb) -- a coluna que manda na categoria 1 -- e de
-- `titulo_numero`, que a tela exibe. Acrescentadas aqui, com os tipos de
-- producao (information_schema, 22/10/2026).
-- ---------------------------------------------------------------------------
alter table public.fila_pagamento_sem_vinculo
  add column if not exists sugestoes jsonb not null default '[]'::jsonb;
alter table public.fila_pagamento_sem_vinculo
  add column if not exists cpf_recebido text;
alter table public.pagamentos
  add column if not exists titulo_numero text;

-- `auth.role()`, que a bancada da rodada nao precisava. O portao da funcao
-- leitora o consulta para liberar `service_role`, do mesmo jeito que
-- `pagamentos_sem_aluno` faz em producao. Stub pelo GUC, como o `auth.jwt()`
-- da bancada: devolve o papel que o teste declarar.
create or replace function auth.role() returns text
 language sql stable as $$
  select nullif(current_setting('request.jwt.role', true), '')
$$;

-- O INDICE UNICO EM QUE A PROMESSA DE "UMA LINHA POR PAGAMENTO" REPOUSA.
-- Existe em producao como `fila_pag_sem_vinculo_unico`; a bancada da rodada nao
-- o criou porque nao precisava dele. O portao da migration confere que ele
-- esta la, entao sem isto a propria migration recusaria rodar -- que e
-- exatamente o comportamento desejado.
create unique index if not exists fila_pag_sem_vinculo_unico
  on public.fila_pagamento_sem_vinculo (pagamento_id);

-- ---------------------------------------------------------------------------
-- AS ETAPAS, COMO ESTAVAM EM PRODUCAO EM 22/10/2026. Apenas as que a triagem
-- consulta. `consulta_portador` DESLIGADA pela gestao desde 15/09/2026 e o
-- fato que cria a categoria 3; `encerrar_ja_paga_conferida` ligada e o que
-- torna a categoria 1 acionavel de verdade.
-- ---------------------------------------------------------------------------
insert into public.fluxo_pagamentos_config (etapa, ligado) values
  ('consulta_portador',           false),
  ('encerrar_ja_paga_conferida',  true),
  ('baixa_pelo_relatorio',        true)
on conflict (etapa) do update set ligado = excluded.ligado;

-- ---------------------------------------------------------------------------
-- A PARTICAO DECLARADA. Uma linha por subcategoria, com a contagem e o valor
-- medidos em producao. E a TABELA-VERDADE dos testes: eles comparam a saida da
-- view contra ela, e o total contra 448 / R$ 377.515,27.
--
-- `motivo_modelo` traz o molde REAL do texto que o motor grava, com `<n>` no
-- lugar dos numeros. Nao e decorativo: e o texto que o classificador tem de
-- reconhecer, e e por isso que trocar a redacao do motor quebra este teste --
-- que e o alarme que se quer ter.
-- ---------------------------------------------------------------------------
create table public._referencia_triagem (
  subcategoria   text primary key,
  categoria      text not null,
  quantidade     int  not null,
  valor_total    numeric(14,2) not null,
  status_pag     text not null,
  motivo_modelo  text,
  decisao        text,
  com_sugestao   boolean not null default false,
  acao_sugerida  text
);

insert into public._referencia_triagem
  (subcategoria, categoria, quantidade, valor_total, status_pag, motivo_modelo, decisao, com_sugestao, acao_sugerida)
values
  -- 1 · ACIONAVEL PELO ADMINISTRATIVO -------------------------------------
  ('ja_paga_conferir_e_encerrar', 'ACIONAVEL_ADMINISTRATIVO', 45, 40261.10,
   'PARCELA_JA_PAGA',
   'a parcela 2 do boleto <n> ja estava PAGO antes deste pagamento entrar: baixa anterior BAIXA_REGISTRADA por rotina@sistema em 04/09/2026',
   null, false, 'CONFERIR_E_ENCERRAR'),

  -- 31 destas 42 NAO mencionam sugestao no texto do motivo: em producao a
  -- coluna `sugestoes` esta preenchida e o texto nao diz nada. E o caso que
  -- prova que dado estruturado tem de mandar.
  ('escolher_aluno_sugerido', 'ACIONAVEL_ADMINISTRATIVO', 42, 23469.07,
   'AGUARDANDO_ACORDO',
   'boleto <n> nao existe em parcelas e o acordo <n> nao esta no CRM | sem CPF no pagamento: identidade precisa ser resolvida antes',
   null, true, 'ESCOLHER_ALUNO'),

  -- 2 · AGUARDANDO INFORMACAO DE ACORDO -----------------------------------
  ('acordo_ausente_no_crm', 'AGUARDANDO_INFORMACAO_ACORDO', 22, 27564.25,
   'AGUARDANDO_ACORDO',
   'boleto <n> nao existe em parcelas e o acordo <n> nao esta no CRM | sem CPF no pagamento: identidade precisa ser resolvida antes',
   null, false, null),

  -- 3 · BLOQUEADO POR ETAPA DESATIVADA ------------------------------------
  -- O motivo PROMETE uma consulta que a configuracao desligou. 59% das linhas e
  -- 49% do dinheiro pendente estao aqui.
  ('consulta_portador', 'BLOQUEADO_ETAPA_DESATIVADA', 265, 186318.47,
   'AGUARDANDO_ACORDO',
   'boleto <n> nao existe em parcelas e o acordo <n> nao esta no CRM | a API oficial ainda nao foi consultada para este caso -- a rodada horaria consulta',
   null, false, null),

  -- 4 · DIVERGENCIA QUE EXIGE CONFERENCIA HUMANA --------------------------
  -- As 33 que ninguem ve: decisao registrada na fila, pagamento ainda pendente.
  ('decidida_mas_ainda_pendente', 'CONFERENCIA_HUMANA', 33, 83203.30,
   'AGUARDANDO_ACORDO',
   'boleto <n> nao existe em parcelas e o acordo <n> nao esta no CRM',
   'RESOLVIDO_AUTOMATICO', false, null),

  ('acordo_sem_parcela_livre', 'CONFERENCIA_HUMANA', 23, 3894.14,
   'REVISAO',
   'o acordo <n> esta no CRM e nao tem parcela livre para receber o boleto <n>',
   null, false, null),

  ('parcela_paga_antes_da_extracao', 'CONFERENCIA_HUMANA', 7, 3107.08,
   'REVISAO',
   'PARCELA_PAGA_ANTES_ACORDO_JA_EXISTIA: acordo importado antes do pagamento: a parcela deveria ter vindo | o acordo <n> esta no CRM e nao tem parcela livre para receber o boleto <n>',
   null, false, null),

  -- Frente da PR #694. Contada aqui, decidida la.
  ('acordo_cancelado_fluxo_proprio', 'CONFERENCIA_HUMANA', 7, 4511.23,
   'REVISAO',
   'o acordo do boleto <n> esta CANCELADO, nao ATIVO',
   null, false, null),

  -- Os tres conferidos um a um em 22/10: boleto reemitido, nao erro de um mes.
  ('boleto_reemitido_vencimento_anterior', 'CONFERENCIA_HUMANA', 3, 2196.08,
   'REVISAO',
   'vencimento do arquivo (04/09/2026) nao bate com a parcela 3 do boleto, que vence 04/10/2026',
   null, false, null),

  ('valor_fora_da_faixa', 'CONFERENCIA_HUMANA', 1, 2990.55,
   'REVISAO',
   'valor pago 2,990.55 fora da faixa aceita para a parcela de 4,454.73 (de -R$ 0,05 ate +15%)',
   null, false, null);

-- ---------------------------------------------------------------------------
-- O GERADOR. Cria `quantidade` pagamentos por subcategoria cujos valores somam
-- EXATAMENTE `valor_total`: cada linha recebe a divisao inteira em centavos e a
-- primeira recebe o resto. Sem isto o total fecharia "quase", e um teste que
-- fecha quase nao prova fechamento.
--
-- `ultima_tentativa_em`/`quantidade_tentativas` vem do gatilho de producao
-- (`_fila_pagamento_tentativa`, BEFORE INSERT), nao de valor escolhido aqui.
-- ---------------------------------------------------------------------------
do $gerador$
declare
  r        record;
  i        int;
  v_n      int := 0;
  v_cent   bigint;
  v_base   bigint;
  v_resto  bigint;
  v_valor  numeric(12,2);
  v_pag    uuid;
  v_aluno  uuid;
begin
  for r in select * from public._referencia_triagem order by subcategoria loop
    v_cent  := round(r.valor_total * 100)::bigint;
    v_base  := v_cent / r.quantidade;
    v_resto := v_cent - (v_base * r.quantidade);

    for i in 1 .. r.quantidade loop
      v_n     := v_n + 1;
      v_valor := ((v_base + case when i = 1 then v_resto else 0 end)::numeric) / 100;
      v_pag   := ('11111111-0000-0000-0000-' || lpad(v_n::text, 12, '0'))::uuid;
      v_aluno := ('22222222-0000-0000-0000-' || lpad(v_n::text, 12, '0'))::uuid;

      insert into public.alunos (id, nome, cpf, saldo_total)
        values (v_aluno, 'ALUNO SINTETICO ' || v_n, lpad(v_n::text, 11, '0'), 0)
        on conflict (id) do nothing;

      insert into public.pagamentos
        (id, aluno_id, cpf, data_pagamento, valor_pago, status_conciliacao,
         conciliacao_motivo, titulo_numero)
      values
        (v_pag, v_aluno, lpad(v_n::text, 11, '0'), date '2026-10-01',
         v_valor, r.status_pag, null, lpad((60000 + v_n)::text, 5, '0'));

      insert into public.fila_pagamento_sem_vinculo
        (pagamento_id, boleto, data_pagamento, valor_pago, motivo, detectado_em,
         decisao, decidido_por, decidido_em, status_conciliacao, sugestoes,
         consulta_portador_em)
      values
        (v_pag,
         '5' || lpad((60000 + v_n)::text, 6, '0') || '0001',
         date '2026-10-01', v_valor,
         replace(r.motivo_modelo, '<n>', (500000 + v_n)::text),
         timestamptz '2026-09-25 12:00:00+00',
         r.decisao,
         case when r.decisao is not null then 'rotina@sistema' end,
         case when r.decisao is not null then timestamptz '2026-10-05 12:00:00+00' end,
         r.status_pag,
         case when r.com_sugestao
              then jsonb_build_array(jsonb_build_object('aluno_id', v_aluno,
                                                        'nome', 'ALUNO SINTETICO ' || v_n))
              else '[]'::jsonb end,
         -- NUNCA preenchido: em producao `consulta_portador_em` e nulo nas 329
         -- linhas de AGUARDANDO_ACORDO. A consulta que o motivo promete nao
         -- aconteceu para nenhuma delas.
         null);
    end loop;
  end loop;

  if v_n <> 448 then
    raise exception 'base de referencia: gerou % pendencias, esperado 448', v_n;
  end if;
end
$gerador$;

-- ---------------------------------------------------------------------------
-- UM PAGAMENTO FORA DO ALCANCE, de proposito: `status_conciliacao` NULO, como
-- os 8.955 historicos anteriores a 11/09. A triagem nao pode vê-lo. Se um dia
-- alguem afrouxar o `where` da view, o teste do fechamento acusa 449.
-- ---------------------------------------------------------------------------
insert into public.alunos (id, nome, cpf, saldo_total)
  values ('22222222-0000-0000-0000-999999999999', 'ALUNO HISTORICO', '99999999999', 0)
  on conflict (id) do nothing;
insert into public.pagamentos
  (id, aluno_id, cpf, data_pagamento, valor_pago, status_conciliacao, titulo_numero)
values
  ('11111111-0000-0000-0000-999999999999', '22222222-0000-0000-0000-999999999999',
   '99999999999', date '2026-08-15', 1234.56, null, '59999');

-- E um BAIXADO, que tambem esta fora: resolvido nao e pendencia.
insert into public.alunos (id, nome, cpf, saldo_total)
  values ('22222222-0000-0000-0000-888888888888', 'ALUNO BAIXADO', '88888888888', 0)
  on conflict (id) do nothing;
insert into public.pagamentos
  (id, aluno_id, cpf, data_pagamento, valor_pago, status_conciliacao, titulo_numero)
values
  ('11111111-0000-0000-0000-888888888888', '22222222-0000-0000-0000-888888888888',
   '88888888888', date '2026-10-10', 777.77, 'BAIXADO', '58888');
