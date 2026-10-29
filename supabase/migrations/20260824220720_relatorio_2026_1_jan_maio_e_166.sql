-- Relatório "Mensalidades 2026/1 sem negociação" — dois acertos de recorte.
-- A TELA NÃO MUDA: mesma RPC, mesmas chaves no JSON, mesmos cards. Só os números.
--
-- ACERTO 1 — o semestre vai até MAIO, não até junho.
-- Descoberto na conferência com a Ulbra Prime em 2026-08-24: o `documentNumber`
-- da parcela termina com o número dela e esse número bate com o mês do
-- vencimento (…9301 00 = parcela 1/janeiro, …9305 00 = 5/maio, …9306 00 =
-- 6/junho). As referências de 2026/1 terminam na parcela 5. O vencimento de
-- junho já é matrícula antecipada de 2026/2 — exatamente o que o aviso da tela
-- sempre disse. Eram R$ 2.863.415,35 entrando no semestre errado.
--
-- ACERTO 2 — quem está no portador 166 da Prime negociou, e sai da conta.
-- O 166 é o SANTANDER REATIVA convênio 272047, onde a Ulbra põe os acordos.
-- Varredura completa de 2026-08-24: dos CPFs do semestre, 1.198 estão lá sem
-- ter acordo nenhum no CRM. Não é cadastro duplicado (testado: explica 5 CPFs,
-- R$ 30.281,91) nem acordo antigo — em 60 sorteados, os 177 títulos de 2026/1
-- aparecem liquidados na Prime, R$ 172.630,41 de R$ 172.630,41.
--
-- EFEITO NA TELA (medido antes de aplicar):
--   CPFs                3.251  ->  2.853
--   Mensalidades        9.595  ->  6.537
--   Saldo   R$ 11.706.185,71  ->  R$ 8.192.910,10
--
-- CONSEQUÊNCIA QUE PRECISA SER DITA: sai também a exclusão por confirmação de
-- pagamento pendente. Ela tirava do relatório 1.366 alunos / R$ 3,84 mi sem
-- avisar em lugar nenhum da tela. Com ela de volta, os números acima não
-- fechariam. Quem tem pagamento a validar volta a ser contado como dívida até
-- a gestão confirmar — que é o estado real dele.
--
-- E a série de `relatorio_mens_2026_1_snapshot` ganha um degrau na data em que
-- isto for aplicado: a captura diária usa esta mesma função. O degrau é a
-- correção, não uma queda de inadimplência.

begin;

-- ---------------------------------------------------------------------------
-- Quem está em cada portador da Prime. Só a chave: CPF + portador.
-- A mesma pessoa aparece nos dois portadores com frequência (23 de 25 num
-- piloto), por isso a PK é composta.
-- ---------------------------------------------------------------------------
create table if not exists public.prime_portador_membro (
  cpf         text    not null,
  portador    integer not null,
  coletado_em timestamptz not null default now(),
  constraint prime_portador_membro_pk primary key (cpf, portador),
  constraint prime_portador_membro_cpf_digitos check (cpf ~ '^[0-9]{11}$'),
  -- Portão de escopo: a Reativa só responde por estes dois portadores. 165
  -- (acordos judiciais) e 202 (cobrança judicial) ficam fora por decisão da
  -- Amanda — carteira judicial não é nossa.
  constraint prime_portador_membro_nosso check (portador in (166, 195))
);

comment on table public.prime_portador_membro is
  'CPFs em cobrança nos portadores 166 (acordos) e 195 (mensalidades) da Ulbra Prime. '
  'Presença no 166 = negociou. Ausência NÃO prova dívida em aberto: a API só devolve liquidados.';

alter table public.prime_portador_membro enable row level security;
-- Sem policy = deny-all para anon e authenticated. Leitura só via
-- SECURITY DEFINER ou service_role.

create index if not exists prime_portador_membro_166_idx
  on public.prime_portador_membro (cpf) where portador = 166;

-- ---------------------------------------------------------------------------
-- Elegibilidade. Mesma assinatura de antes — a RPC e a captura diária seguem
-- chamando sem saber que algo mudou.
-- ---------------------------------------------------------------------------
create or replace function public._relatorio_2026_1_eleg()
returns table (id uuid, aluno_id uuid, cpf text, mes integer, saldo numeric,
               curso text, unidade text, faixa text, faixa_ordem integer)
language sql
stable
security definer
set search_path to 'public'
as $function$
  SELECT t.id, t.aluno_id,
         lpad(regexp_replace(coalesce(t.cpf,''),'\D','','g'),11,'0'),
         extract(month from t.vencimento)::int,
         coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0),
         CASE
           WHEN t.tipo_boleto ILIKE 'Cursos de Gradua%Presencial' THEN 'Graduação Presencial'
           WHEN t.tipo_boleto ILIKE 'Cursos de Gradua%Online'     THEN 'Graduação Online'
           WHEN t.tipo_boleto ILIKE 'Cursos de Gradua%Híbrido' OR t.tipo_boleto ILIKE 'Cursos de Gradua%brido' THEN 'Graduação Híbrido'
           WHEN t.tipo_boleto ILIKE 'Cursos de Pós%'             THEN 'Pós-Graduação (Lato Sensu)'
           WHEN t.tipo_boleto ILIKE 'Extens%'                    THEN 'Extensão'
           ELSE coalesce(nullif(trim(t.tipo_boleto),''),'(não informado)')
         END,
         coalesce(nullif(upper(regexp_replace(public.unaccent(coalesce(al.unidade,'')),'\s+',' ','g')),''),'(NÃO INFORMADO)'),
         CASE
           WHEN coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 2000 THEN 'Acima de R$ 2.000'
           WHEN coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 1000 THEN 'R$ 1.000 a R$ 2.000'
           WHEN coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) >  500 THEN 'R$ 500 a R$ 1.000'
           ELSE 'Até R$ 500'
         END,
         CASE
           WHEN coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 2000 THEN 4
           WHEN coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 1000 THEN 3
           WHEN coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) >  500 THEN 2
           ELSE 1
         END
  FROM public.acordos_titulos t
  LEFT JOIN public.alunos al ON al.id = t.aluno_id
  -- ACERTO 1: janeiro a MAIO.
  WHERE t.vencimento between date '2026-01-01' and date '2026-05-31'
    AND upper(coalesce(t.situacao,'')) = 'ABERTO'
    AND lower(coalesce(t.status,''))   = 'em_aberto'
    AND coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 0
    AND t.acordo_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.acordo_titulo_vinculo v WHERE v.titulo_id = t.id)
    AND NOT EXISTS (
          SELECT 1 FROM public.casos c
           WHERE c.aluno_id = t.aluno_id
             AND public.normalizar_status_acionamento(
                   coalesce(c.status_atual, c.status_acionamento, c.status_jornada)
                 ) = any(array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO'])
        )
    -- ACERTO 2: quem está no portador de acordos da Prime negociou.
    AND NOT EXISTS (
          SELECT 1 FROM public.prime_portador_membro pm
           WHERE pm.portador = 166
             AND pm.cpf = lpad(regexp_replace(coalesce(t.cpf,''),'\D','','g'),11,'0')
        );
  -- A exclusão por solicitação AGUARDANDO_CONFIRMACAO saiu de propósito: ver
  -- o cabeçalho desta migration.
$function$;

-- ---------------------------------------------------------------------------
-- A RPC da tela. Mesmas chaves, mesmos nomes — o front não muda uma linha.
-- Único ajuste: a régua de meses vai de 1 a 5. O componente usa
-- `meses.length`, então o gráfico e a tabela se ajustam sozinhos.
-- ---------------------------------------------------------------------------
create or replace function public.relatorio_mensalidades_2026_1_sem_negociacao()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
DECLARE
  v_email text := lower(coalesce(auth.email(),''));
  v_gestao boolean := v_email IN ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br','cobranca07@aelbra.com.br')
                      OR public.usuario_e_diretoria();
  v_out jsonb;
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' AND NOT v_gestao THEN
    RAISE EXCEPTION 'Acesso negado: relatorio restrito a gestao.' USING ERRCODE='42501';
  END IF;

  WITH eleg AS (SELECT * FROM public._relatorio_2026_1_eleg()),
  por_mes AS (
    SELECT g.mes AS mes_numero,
      (array['Janeiro','Fevereiro','Março','Abril','Maio'])[g.mes] AS mes_nome,
      count(distinct e.cpf) AS cpfs, count(distinct e.aluno_id) AS alunos_unicos,
      count(e.id) AS mensalidades_sem_negociacao, round(coalesce(sum(e.saldo),0),2) AS saldo_sem_negociacao
    FROM generate_series(1,5) g(mes) LEFT JOIN eleg e ON e.mes = g.mes GROUP BY g.mes
  ),
  por_curso AS (SELECT curso, count(*) AS mensalidades, count(distinct aluno_id) AS alunos, round(sum(saldo),2) AS saldo FROM eleg GROUP BY curso),
  por_unidade AS (SELECT unidade, count(*) AS mensalidades, count(distinct aluno_id) AS alunos, round(sum(saldo),2) AS saldo FROM eleg GROUP BY unidade),
  por_faixa AS (SELECT faixa, faixa_ordem, count(*) AS mensalidades, count(distinct aluno_id) AS alunos, round(sum(saldo),2) AS saldo FROM eleg GROUP BY faixa, faixa_ordem),
  tot AS (SELECT count(distinct cpf) AS cpfs, count(distinct aluno_id) AS alunos, count(*) AS mens, round(coalesce(sum(saldo),0),2) AS saldo FROM eleg),
  -- Quem saiu por ter negociado no 166, no mesmo recorte de jan-mai. Fica
  -- disponível para a tela mostrar ao lado quando quiserem.
  neg AS (
    SELECT count(distinct lpad(regexp_replace(coalesce(t.cpf,''),'\D','','g'),11,'0')) AS cpfs,
           count(*) AS mensalidades, round(coalesce(sum(coalesce(t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0)),0),2) AS saldo
      FROM public.acordos_titulos t
     WHERE t.vencimento between date '2026-01-01' and date '2026-05-31'
       AND upper(coalesce(t.situacao,'')) = 'ABERTO'
       AND lower(coalesce(t.status,''))   = 'em_aberto'
       AND coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 0
       AND t.acordo_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.acordo_titulo_vinculo v WHERE v.titulo_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM public.casos c WHERE c.aluno_id = t.aluno_id
             AND public.normalizar_status_acionamento(coalesce(c.status_atual,c.status_acionamento,c.status_jornada))
                 = any(array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO']))
       AND EXISTS (SELECT 1 FROM public.prime_portador_membro pm
                    WHERE pm.portador = 166
                      AND pm.cpf = lpad(regexp_replace(coalesce(t.cpf,''),'\D','','g'),11,'0'))
  )
  SELECT jsonb_build_object(
    'meses', (SELECT coalesce(jsonb_agg(p ORDER BY p.mes_numero),'[]'::jsonb) FROM por_mes p),
    'por_curso', (SELECT coalesce(jsonb_agg(c ORDER BY c.saldo DESC),'[]'::jsonb) FROM por_curso c),
    'por_unidade', (SELECT coalesce(jsonb_agg(u ORDER BY u.saldo DESC),'[]'::jsonb) FROM por_unidade u),
    'por_faixa', (SELECT coalesce(jsonb_agg(f ORDER BY f.faixa_ordem DESC),'[]'::jsonb) FROM por_faixa f),
    'destaques', jsonb_build_object(
      'curso_maior_inadimplencia',   (SELECT to_jsonb(c) FROM por_curso c ORDER BY c.saldo DESC LIMIT 1),
      'unidade_maior_inadimplencia', (SELECT to_jsonb(u) FROM por_unidade u ORDER BY u.saldo DESC LIMIT 1),
      'unidade_maior_volume',        (SELECT to_jsonb(u) FROM por_unidade u ORDER BY u.mensalidades DESC LIMIT 1),
      'faixa_maior_saldo',           (SELECT to_jsonb(f) FROM por_faixa f ORDER BY f.saldo DESC LIMIT 1),
      'faixa_maior_volume',          (SELECT to_jsonb(f) FROM por_faixa f ORDER BY f.mensalidades DESC LIMIT 1),
      'mes_maior_inadimplencia',     (SELECT to_jsonb(p) FROM por_mes p ORDER BY p.saldo_sem_negociacao DESC LIMIT 1),
      'mes_maior_volume',            (SELECT to_jsonb(p) FROM por_mes p ORDER BY p.mensalidades_sem_negociacao DESC LIMIT 1)
    ),
    'evolucao_diaria', (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'dia', s.dia, 'cpfs', s.cpfs, 'alunos', s.alunos, 'mensalidades', s.mensalidades,
        'saldo', s.saldo, 'origem', s.origem
      ) ORDER BY s.dia),'[]'::jsonb) FROM public.relatorio_mens_2026_1_snapshot s),
    'alunos_unicos_semestre', (SELECT alunos FROM tot),
    'cpfs_semestre', (SELECT cpfs FROM tot),
    'mensalidades_total', (SELECT mens FROM tot),
    'saldo_total', (SELECT saldo FROM tot),
    'negociado_166', (SELECT to_jsonb(n) FROM neg n),
    'casos_em_confirmacao', 0,
    'casos_em_revisao_manual', 0,
    'atualizado_em', now()
  ) INTO v_out;
  RETURN v_out;
END;
$function$;

commit;
