-- COMPLEMENTO DA BANCADA PARA A ONDA 1 — corpos de PRODUÇÃO de 21/10/2026.
--
-- A bancada é montada em três camadas, para não reescrever nada:
--   1. `fidelizacao_por_dono_prod_20260930.sql` — tabelas (`casos`, `alunos`,
--      `usuarios`, `acordos`, `parcelas`, `acordos_titulos`,
--      `acordo_titulo_vinculo`, `calibragem_parametros`) e as funções
--      `caso_protegido_redistribuicao`, `caso_encerrado_operacional`,
--      `titulo_superado_por_acordo`;
--   2. `nivelamento_m3_prod_20261021.sql` — a coluna `casos.giro_fidelizacao_ate`,
--      `caso_em_giro_fidelizacao`, `parcela_viva` e `calibragem_e_gestao`;
--   3. este arquivo — só o que ainda falta.
--
-- Cada corpo é o EXATO de produção e o teste confere um por um por
-- `md5(prosrc)`. Transcrição errada por um caractere para a bancada antes do
-- primeiro teste.
--
-- NENHUM DADO REAL: só estrutura e corpo de função.

-- ---------------------------------------------------------------------------
-- Semestre do título pela Prime. É a perna "híbrida" da régua: quando existe,
-- ela manda; o vencimento é o fallback.
-- ---------------------------------------------------------------------------
create table if not exists public.prime_titulo_semestre (
  boleto text, cpf text, semestre text, serie text, parcela numeric,
  vencimento date, liquidado_em date, coletado_em timestamptz, carrier_id integer
);

-- ---------------------------------------------------------------------------
-- Onde a simulação é registrada. A Onda 1 grava UMA linha aqui, com status
-- RASCUNHO -- e é a única escrita que ela faz.
-- ---------------------------------------------------------------------------
create table if not exists public.calibragem_simulacoes (
  id uuid primary key default gen_random_uuid(),
  criado_por_email text not null,
  criado_por_nome text,
  criterios jsonb not null,
  resultado jsonb,
  status text not null default 'RASCUNHO',
  aprovado_por_email text,
  aprovado_por_nome text,
  aprovado_em timestamptz,
  executado_em timestamptz,
  observacao text,
  criado_em timestamptz not null default now()
);

CREATE OR REPLACE FUNCTION public.mask_cpf(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT CASE
           WHEN p IS NULL OR btrim(p) = '' THEN NULL
           ELSE '***' || right(regexp_replace(p, '[^0-9]', '', 'g'), 3)
         END
$function$;

CREATE OR REPLACE FUNCTION public.calibragem_teto_operador(p_email text)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_teto int;
begin
  -- Teto individual, quando a gestao definiu um para este operador.
  begin
    select nullif(p.valor ->> lower(coalesce(p_email,'')), '')::int
      into v_teto
      from public.calibragem_parametros p
     where p.chave = 'limite_por_operador';
  exception when others then v_teto := null;
  end;

  -- Senao, o teto geral.
  if v_teto is null then
    begin
      -- `#>> '{}'` extrai o escalar tanto de 500 quanto de "500".
      select nullif(p.valor #>> '{}', '')::int
        into v_teto
        from public.calibragem_parametros p
       where p.chave = 'limite_carteira';
    exception when others then v_teto := null;
    end;
  end if;

  -- Piso de seguranca: teto zerado ou negativo esvaziaria as carteiras.
  if v_teto is null or v_teto < 1 then v_teto := 500; end if;
  return v_teto;
end;
$function$;
