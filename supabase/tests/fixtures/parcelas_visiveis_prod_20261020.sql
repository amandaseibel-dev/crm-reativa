-- COMPLEMENTO DE PRODUCAO para o teste de visibilidade de parcelas -- 20/10/2026.
--
-- A fixture `fidelizacao_por_dono_prod_20260930.sql` ja traz, com o texto EXATO
-- de producao e md5 por corpo: as tabelas `parcelas`, `acordos`, `alunos`,
-- `casos` e `usuarios`, os gatilhos de `casos`, e as funcoes que decidem o
-- bloqueio: `caso_encerrado_operacional`, `normalizar_status_acionamento`,
-- `saldo_titulos_aberto`, `usuario_e_gestao`, `usuario_e_gestao_fila`, mais o
-- stub de `auth.jwt()`.
--
-- Falta nela o que este teste precisa: a tabela de alertas de parcela e as tres
-- funcoes de leitura. Tudo abaixo e o texto exato de producao, conferido por md5
-- em `parcelas_visiveis_prod_20261020.md5.json`.
--
-- NENHUM DADO REAL: so estrutura e corpo de funcao.

-- ===========================================================================
-- A tabela de alertas de parcela (estrutura de producao, 13 colunas)
-- ===========================================================================
create table if not exists public.acordo_alertas_parcela (
  id uuid not null default gen_random_uuid(),
  acordo_id uuid not null,
  aluno_id uuid not null,
  parcela_id uuid not null,
  numero_parcela integer,
  valor numeric not null,
  vencimento date not null,
  data_alerta date not null,
  tipo text not null default 'D2'::text,
  responsavel_email text,
  resolvido_em timestamp with time zone,
  resolucao text,
  criado_em timestamp with time zone not null default now(),
  constraint acordo_alertas_parcela_pkey primary key (id)
);

-- ===========================================================================
-- public.parcela_viva -- a regra de "parcela que ainda nos pertence"
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.parcela_viva(p_status text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select upper(coalesce(p_status, '')) not in (
    -- pagamento real (regra 1: so aqui entra dinheiro)
    'PAGO', 'PAGA',
    -- saida por cancelamento/estorno
    'CANCELADA', 'CANCELADO', 'ESTORNADA', 'ESTORNADO',
    -- regra 2: saiu definitivamente da nossa responsabilidade, SEM pagamento
    'DEVOLVIDA',
    -- regra 3: cobranca suspensa temporariamente, SEM pagamento
    'SUSPENSA'
  );
$function$;

-- ===========================================================================
-- public.parcelas_vencendo_2_dias -- ALVO 1 (o selo da fila)
-- md5(prosrc) = 662c264c4bf6385d023cc01fb43aebe5
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.parcelas_vencendo_2_dias()
 RETURNS TABLE(aluno_nome text, aluno_id uuid, numero integer, valor numeric, vencimento date, operador_email text, operador_nome text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT a.nome, ac.aluno_id, p.numero, p.valor, p.vencimento, ac.operador_responsavel_email, ac.operador_responsavel_nome
  FROM public.parcelas p
  JOIN public.acordos ac ON ac.id = p.acordo_id
  JOIN public.alunos a ON a.id = ac.aluno_id
  WHERE public.parcela_viva(p.status)
    AND p.vencimento = current_date + interval '2 days'
    AND (
      public.usuario_e_gestao_fila()
      OR lower(ac.operador_responsavel_email) = lower(coalesce(auth.jwt()->>'email',''))
    )
  ORDER BY p.vencimento ASC;
$function$;

-- ===========================================================================
-- public.acordo_alertas_do_operador -- ALVO 2 (a lista de alertas)
-- md5(prosrc) = dff8a61dd1afe91f4f84304deec9eda9
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.acordo_alertas_do_operador(p_aluno_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(aluno_id uuid, aluno_nome text, acordo_id uuid, numero_acordo integer, parcela_id uuid, numero_parcela integer, valor numeric, vencimento date, dias_restantes integer, data_alerta date, responsavel_email text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select x.aluno_id, al.nome::text, x.acordo_id, a.numero_acordo::int, x.parcela_id, x.numero_parcela::int, x.valor::numeric, x.vencimento,
         (x.vencimento - current_date)::int, x.data_alerta, x.responsavel_email
    from public.acordo_alertas_parcela x
    join public.acordos a on a.id = x.acordo_id
    left join public.alunos al on al.id = x.aluno_id
   where x.resolvido_em is null and x.tipo = 'D2'
     and (p_aluno_id is null or x.aluno_id = p_aluno_id)
     and (public.usuario_e_gestao() or lower(coalesce(x.responsavel_email,'')) = lower(coalesce(auth.jwt()->>'email','')))
   order by x.vencimento, al.nome;
$function$;
