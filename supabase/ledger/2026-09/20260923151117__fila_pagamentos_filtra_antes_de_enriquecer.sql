-- A FILA DE PAGAMENTOS VOLTOU A ABRIR: FILTRAR PRIMEIRO, ENRIQUECER DEPOIS.
--
-- O QUE QUEBROU, E POR MINHA CONTA. A migration 20260923120810 deu a
-- `pagamentos_sem_aluno` tres campos novos (acordo identificado, evidencias,
-- saldo). Em producao a tela passou a responder
-- `canceling statement due to statement timeout` -- o teto de 8s do papel
-- `authenticated`. Medido no banco de producao: **29.308 ms**.
--
-- A CAUSA NAO E O QUE PARECE. Os campos novos custam pouco:
--
--   contagem de alunos pelo NOME .... 35,4 ms x 810 voltas = 28,7 s   <-- antigo
--   CPF no portador 166 ............. 9,6 ms x 39 voltas  = 0,4 s     <-- novo
--   acordo pelo prefixo do boleto ... 3,9 ms x 39 voltas  = 0,2 s     <-- novo
--
-- O peso esta na contagem por nome, que ja existia desde sempre. Ela roda como
-- `left join lateral` ANTES do filtro que corta a populacao, entao a quantidade
-- de voltas depende do plano que o Postgres escolher. Com a funcao antiga o
-- planejador aplicava o filtro cedo (hash join) e sobravam ~39 voltas; ao
-- acrescentar mais um join e mais uma lateral, os custos estimados mudaram, o
-- plano virou nested loop e a MESMA lateral antiga passou a rodar 810 vezes.
-- 911.253 heap fetches depois, estourou o teto.
--
-- Ou seja: o campo novo nao era caro -- ele desequilibrou um plano que ja era
-- fragil. Esse tipo de defeito volta sozinho quando as estatisticas mudarem,
-- entao nao adianta "otimizar" um pedaco e torcer.
--
-- A CORRECAO: A POPULACAO VIRA UMA CTE `MATERIALIZED`.
-- `base` calcula PRIMEIRO quem entra na fila -- 39 linhas hoje -- e so depois
-- as laterais e os joins enriquecem essas linhas. `materialized` nao e enfeite:
-- e o que impede o planejador de voltar a embutir a subconsulta e reintroduzir
-- o mesmo problema numa proxima mudanca de estatistica.
--
-- Medido em producao, com os mesmos dados e as mesmas 39 linhas de resultado:
--   mes corrente ......... 29.308 ms  ->  1.586 ms
--   todos os meses ....... (mesmo plano ruim)  ->  1.290 ms
--
-- O QUE ESTA MIGRATION NAO FAZ, DE PROPOSITO:
--
--   * NAO mexe na contagem por nome. Ela continua cara (cerca de 1 s das 1,3 s
--     restantes) porque compara `upper(trim(nome))` sem indice que sirva. Mudar
--     isso mexeria em `motivo`/`candidatos`, que e comportamento -- e nao e o
--     defeito de hoje. Fica anotado para quando for a vez dela.
--   * NAO aumenta o `statement_timeout` da funcao. Ja existe precedente disso
--     no projeto (`projecao_importar_pagamentos`, 60 s), mas ali o trabalho
--     pesado e real e roda uma vez por importacao. Aqui e uma TELA: se ela
--     precisa de mais de 8 s, o certo e a consulta caber, nao o teto subir.
--   * NAO troca assinatura. E `create or replace` sobre a mesma assinatura,
--     entao os grants ficam onde estao -- diferente da 20260923120810, que
--     precisou de `drop` e teve de reconceder.
--
-- NENHUMA LINHA DE SAIDA MUDA: mesmas colunas, mesma ordem, mesmos valores,
-- mesma ordenacao. O teste compara o resultado desta versao com o da anterior,
-- linha a linha.

create or replace function public.pagamentos_sem_aluno(
  p_mes text default null::text, p_todos_os_meses boolean default false)
 returns table(
   pagamento_id uuid, data_pagamento date, aluno_nome text, matricula text,
   titulo_numero text, numero_parcela_completo text, valor_pago numeric,
   valor_honorario numeric, operador_nome text, operador_email text,
   motivo text, candidatos integer, motivo_financeiro text, sugestoes jsonb,
   detectado_em timestamp with time zone, importacao_id uuid, arquivo_nome text,
   status_conciliacao text, tem_aluno boolean,
   acordo_identificado text, evidencias jsonb, saldo_total numeric, saldo_vencido numeric)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'A fila de pagamentos sem vinculo e da gestao financeira.' using errcode = '42501';
  end if;

  return query
  with mes as (
    select coalesce(p_mes, to_char(now() at time zone 'America/Sao_Paulo', 'YYYY-MM')) as m
  ),
  -- QUEM ENTRA NA FILA -- E SO ISSO. Calculado antes de qualquer
  -- enriquecimento. `materialized` segura o resultado aqui: sem ele o
  -- planejador pode embutir esta subconsulta no resto e voltar a rodar as
  -- laterais para a tabela inteira, que foi exatamente o timeout de 23/09.
  base as materialized (
    select p.id, p.data_pagamento, p.aluno_nome, p.matricula, p.titulo_numero,
           p.numero_parcela_completo, p.valor_pago, p.valor_honorario,
           p.operador_nome, p.operador_email, p.conciliacao_motivo,
           p.importacao_id, p.status_conciliacao, p.aluno_id, p.cpf
      from public.pagamentos p
      cross join mes
     where (p.aluno_id is null
            or exists (select 1 from public.fila_pagamento_sem_vinculo f
                        where f.pagamento_id = p.id and f.decisao is null))
       -- ENCERRADA SAI DA FILA ATIVA (17/09/2026). Sem isto, a linha decidida
       -- volta a aparecer pelo `p.aluno_id is null` -- e encerrar nao resolveria
       -- nada para quem olha a tela.
       and not exists (select 1 from public.fila_pagamento_sem_vinculo fd
                        where fd.pagamento_id = p.id and fd.decisao is not null)
       and (coalesce(p_todos_os_meses, false)
            or to_char(p.data_pagamento, 'YYYY-MM') = mes.m)
  )
  select
    b.id, b.data_pagamento, b.aluno_nome, b.matricula,
    b.titulo_numero, b.numero_parcela_completo,
    b.valor_pago, b.valor_honorario,
    b.operador_nome, b.operador_email,
    case when c.qtd > 1 then 'NOME_REPETIDO' else 'SEM_CADASTRO' end::text,
    coalesce(c.qtd, 0)::int,
    -- Preferir o motivo da conciliacao, que e o novo e o mais especifico;
    -- cair para o motivo da fila; e so entao dizer que a linha e anterior.
    coalesce(b.conciliacao_motivo, f.motivo,
             'entrou antes da regra de identificador financeiro (12/09/2026)')::text,
    coalesce(f.sugestoes, '[]'::jsonb),
    f.detectado_em,
    b.importacao_id,
    i.arquivo_nome,
    b.status_conciliacao,
    (b.aluno_id is not null),
    -- ACORDO IDENTIFICADO: o prefixo de 6 digitos do boleto de acordo
    -- (5 + acordo + parcela). Fora do padrao de 11 digitos, nao ha prefixo.
    ev.prefixo,
    -- EVIDENCIAS: o que EXISTE hoje, em fato verificavel. Nenhuma inferencia,
    -- nenhuma sugestao de acao -- a tela mostra e quem decide e a gestao.
    jsonb_build_object(
      'acordo_prefixo',        ev.prefixo,
      'acordo_no_crm',         ev.acordo_no_crm,
      'acordo_status',         ev.acordo_status,
      'parcela_com_este_boleto', ev.parcela_existe,
      'parcela_status',        ev.parcela_status,
      'documento',             nullif(b.titulo_numero,''),
      'cpf_no_portador_166',   ev.no_166,
      'consulta_estrutura',    f.consulta_estrutura_resultado,
      'evidencia_origem',      f.evidencia_origem,
      'evidencia_em',          f.evidencia_em,
      'tentativas',            coalesce(f.quantidade_tentativas, 0),
      'primeira_tentativa_em', f.primeira_tentativa_em,
      'ultima_tentativa_em',   f.ultima_tentativa_em
    ),
    al.saldo_total,
    al.saldo_vencido
  from base b
  left join public.fila_pagamento_sem_vinculo f
    on f.pagamento_id = b.id and f.decisao is null
  left join public.importacoes i on i.id = b.importacao_id
  left join public.alunos al on al.id = b.aluno_id
  -- NOME NAO VINCULA: continua sendo so contagem de homonimos, para a tela
  -- mostrar o risco. Cara, e antiga -- ver o cabecalho.
  left join lateral (
    select count(*)::int as qtd from public.alunos a
     where upper(trim(a.nome)) = upper(trim(coalesce(b.aluno_nome,'')))
       and coalesce(trim(b.aluno_nome),'') <> ''
  ) c on true
  left join lateral (
    select
      pref.v as prefixo,
      (ac.id is not null) as acordo_no_crm,
      ac.status as acordo_status,
      (pa.id is not null) as parcela_existe,
      pa.status as parcela_status,
      exists (select 1 from public.prime_portador_membro m
               where m.portador = 166
                 and lpad(m.cpf, 11, '0')
                   = lpad(regexp_replace(coalesce(b.cpf,''), '\D', '', 'g'), 11, '0')
                 and coalesce(b.cpf,'') <> '') as no_166
    from (select case when length(coalesce(b.numero_parcela_completo,'')) = 11
                      then substring(b.numero_parcela_completo, 2, 6) end as v) pref
    left join public.acordos ac
      on ac.numero_ulbra is not null
     and lpad(ac.numero_ulbra, 6, '0') = pref.v
     and upper(coalesce(ac.status,'')) <> 'CANCELADO'
    left join public.parcelas pa
      on pa.boleto = nullif(ltrim(coalesce(b.numero_parcela_completo,''),'0'), '')
  ) ev on true
  order by b.data_pagamento desc, b.valor_pago desc;
end;
$function$;

comment on function public.pagamentos_sem_aluno(text, boolean) is
  'Fila de pagamentos sem baixa, para a gestao conferir. Devolve o acordo identificado pelo prefixo do boleto, as evidencias verificaveis (acordo no CRM, parcela com o boleto, CPF no portador 166, consulta de estrutura, tentativas) e o saldo do aluno -- tudo diagnostico, nenhum vinculo. Desde 23/09/2026 a populacao e uma CTE `materialized`: filtrar antes de enriquecer e o que mantem a consulta dentro do teto de 8s do papel authenticated.';

-- === PROVAS ================================================================
do $prova$
declare v_src text;
begin
  select prosrc into v_src from pg_proc
    where oid = 'public.pagamentos_sem_aluno(text,boolean)'::regprocedure;

  -- A CTE materializada E a correcao. Sem ela o plano volta a poder rodar as
  -- laterais para a tabela inteira -- foi assim que a tela caiu.
  if v_src !~* 'base\s+as\s+materialized' then
    raise exception 'PROVA: a populacao precisa ser uma CTE materialized -- e o que evita o timeout';
  end if;

  -- O enriquecimento tem de ler de `base`, nao de `pagamentos`: se alguma
  -- lateral voltar a se correlacionar com a tabela toda, o defeito volta.
  if v_src ~* 'lateral\s*\([^)]*from\s+public\.alunos[^)]*p\.aluno_nome' then
    raise exception 'PROVA: lateral correlacionada com pagamentos em vez de base';
  end if;

  if v_src !~* 'usuario_e_gestao' then
    raise exception 'PROVA: a fila perdeu o portao da gestao';
  end if;

  -- `create or replace` sobre a mesma assinatura preserva os grants; esta
  -- prova existe para o caso de alguem trocar por drop+create no futuro.
  if not has_function_privilege('authenticated', 'public.pagamentos_sem_aluno(text,boolean)', 'EXECUTE')
     or has_function_privilege('anon', 'public.pagamentos_sem_aluno(text,boolean)', 'EXECUTE') then
    raise exception 'PROVA: permissao errada apos a substituicao';
  end if;
end
$prova$;
