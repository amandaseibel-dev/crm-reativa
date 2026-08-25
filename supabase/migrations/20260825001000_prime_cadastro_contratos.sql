-- Atualização cadastral pela Ulbra Prime: contratos e semestre da dívida.
--
-- PARA QUE SERVE, em uma frase cada:
--
--  * `prime_contratos` responde "este aluno está matriculado em 2026/2?".
--    O que responde isso é a JANELA do contrato (01/07 a 31/12/2026) somada ao
--    status. ATENÇÃO ao campo `referenceSemester` da API: ele NÃO é o semestre
--    do calendário, é o período do aluno no curso -- foram vistos 1, 2, 4, 5 e
--    6 em contratos da mesma janela. Quem manda é a data.
--
--  * `prime_titulo_semestre` responde "de que semestre é esta dívida?".
--    A ligação é exata: o `boleto` da parcela na Prime é o mesmo número do
--    nosso `acordos_titulos.documento`. Conferido no aluno 2025012768 -- os
--    seis títulos 4097690..4097695 são as seis parcelas da série 0104425930.
--
-- POR QUE NÃO DÁ PARA DEDUZIR O SEMESTRE PELO MÊS DO VENCIMENTO: matrícula
-- antecipada. O aluno paga em junho uma parcela que é do contrato de 2026/2.
-- Pelo mês, cairia em 2026/1. Quem separa é a série de cobrança -- o prefixo
-- do `documentNumber`, que é próprio de cada contrato. A classificação é feita
-- na coleta, por série, e chega aqui pronta.

begin;

-- ---------------------------------------------------------------------------
-- Contratos
-- ---------------------------------------------------------------------------
create table if not exists public.prime_contratos (
  cpf              text not null,
  registration     text not null,
  valid_from       date not null,
  valid_to         date,
  -- 'Confirmado' = matrícula fechada. 'Aberto' = iniciada e não confirmada --
  -- é o estado da maioria dos contratos de 2026/2 na amostra, e a operação
  -- precisa ver essa diferença. 'Anulado' não conta como matrícula.
  status           text,
  tipo             text,
  curso            text,
  campus           text,
  turno            text,
  periodo_curso    integer,   -- o `referenceSemester` da API, guardado como é
  cancelado_em     date,
  coletado_em      timestamptz not null default now(),
  constraint prime_contratos_pk primary key (cpf, registration, valid_from),
  constraint prime_contratos_cpf_digitos check (cpf ~ '^[0-9]{11}$')
);

comment on column public.prime_contratos.periodo_curso is
  'referenceSemester da Prime: periodo do aluno no curso (1..N). NAO e o semestre do calendario.';

create index if not exists prime_contratos_janela_idx
  on public.prime_contratos (cpf, valid_from desc);

alter table public.prime_contratos enable row level security;
drop policy if exists prime_contratos_select on public.prime_contratos;
create policy prime_contratos_select on public.prime_contratos
  for select to authenticated using (NOT public.eh_painel());

-- ---------------------------------------------------------------------------
-- Semestre de cada título, pelo boleto
-- ---------------------------------------------------------------------------
create table if not exists public.prime_titulo_semestre (
  boleto           text primary key,
  cpf              text not null,
  semestre         text,        -- '2026/1', '2026/2'...
  serie            text,        -- prefixo do documentNumber = a série de cobrança
  parcela          integer,
  vencimento       date,
  liquidado_em     date,        -- paymentDate da Prime, quando houver
  coletado_em      timestamptz not null default now(),
  constraint prime_titulo_semestre_cpf_digitos check (cpf ~ '^[0-9]{11}$'),
  constraint prime_titulo_semestre_formato check (semestre is null or semestre ~ '^[0-9]{4}/[12]$')
);

create index if not exists prime_titulo_semestre_cpf_idx
  on public.prime_titulo_semestre (cpf);

comment on table public.prime_titulo_semestre is
  'Semestre de cada boleto, vindo da Prime. Casa com acordos_titulos.documento. '
  'O semestre vem da janela do contrato da SERIE, nao do mes do vencimento -- '
  'e o que faz a matricula antecipada cair no semestre certo.';

alter table public.prime_titulo_semestre enable row level security;
drop policy if exists prime_titulo_semestre_select on public.prime_titulo_semestre;
create policy prime_titulo_semestre_select on public.prime_titulo_semestre
  for select to authenticated using (NOT public.eh_painel());

-- ---------------------------------------------------------------------------
-- Ingestão. A Edge Function manda o aluno inteiro já classificado; aqui a
-- gravação é uma transação só, para nunca ficar meio aluno gravado.
--
-- Telefones e e-mails passam pela RPC de contatos, então valem as mesmas
-- regras: complementa, não duplica e NÃO ressuscita quem foi invalidado.
-- ---------------------------------------------------------------------------
create or replace function public.prime_cadastro_aplicar(p_dados jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_cpf       text := regexp_replace(coalesce(p_dados->>'cpf',''), '\D', '', 'g');
  v_reg       text := nullif(p_dados->>'registration','');
  v_aluno     uuid;
  v_item      jsonb;
  v_tel_novos int := 0;
  v_mail_novos int := 0;
  v_ct        int := 0;
  v_tit       int := 0;
  v_r         jsonb;
BEGIN
  -- Só o backend. Nenhum operador chama isto direto.
  IF coalesce(auth.role(),'') <> 'service_role' THEN
    RAISE EXCEPTION 'Acesso negado: apenas service_role.' USING ERRCODE='42501';
  END IF;
  IF v_cpf !~ '^[0-9]{11}$' THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'CPF_INVALIDO');
  END IF;

  -- CPF duplicado existe na base. Pega o cadastro mais antigo, que e o que a
  -- operacao trata como o principal.
  SELECT id INTO v_aluno FROM public.alunos
   WHERE lpad(regexp_replace(coalesce(cpf,''), '\D', '', 'g'), 11, '0') = v_cpf
   ORDER BY created_at NULLS LAST LIMIT 1;

  -- Contatos: só entram se o aluno existe na nossa base.
  IF v_aluno IS NOT NULL THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_dados->'telefones','[]'::jsonb)) LOOP
      v_r := public.aluno_contato_adicionar(v_aluno, 'telefone', v_item #>> '{}', 'prime');
      IF coalesce((v_r->>'novo')::boolean, false) THEN v_tel_novos := v_tel_novos + 1; END IF;
    END LOOP;

    FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_dados->'emails','[]'::jsonb)) LOOP
      v_r := public.aluno_contato_adicionar(v_aluno, 'email', v_item #>> '{}', 'prime');
      IF coalesce((v_r->>'novo')::boolean, false) THEN v_mail_novos := v_mail_novos + 1; END IF;
    END LOOP;
  END IF;

  -- Contratos
  FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_dados->'contratos','[]'::jsonb)) LOOP
    INSERT INTO public.prime_contratos
      (cpf, registration, valid_from, valid_to, status, tipo, curso, campus, turno, periodo_curso, cancelado_em, coletado_em)
    VALUES
      (v_cpf, coalesce(v_reg,'?'), (v_item->>'valid_from')::date, (v_item->>'valid_to')::date,
       v_item->>'status', v_item->>'tipo', v_item->>'curso', v_item->>'campus', v_item->>'turno',
       (v_item->>'periodo_curso')::int, (v_item->>'cancelado_em')::date, now())
    ON CONFLICT (cpf, registration, valid_from) DO UPDATE SET
      valid_to = excluded.valid_to, status = excluded.status, tipo = excluded.tipo,
      curso = excluded.curso, campus = excluded.campus, turno = excluded.turno,
      periodo_curso = excluded.periodo_curso, cancelado_em = excluded.cancelado_em,
      coletado_em = now();
    v_ct := v_ct + 1;
  END LOOP;

  -- Títulos
  FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_dados->'titulos','[]'::jsonb)) LOOP
    CONTINUE WHEN nullif(v_item->>'boleto','') IS NULL;
    INSERT INTO public.prime_titulo_semestre
      (boleto, cpf, semestre, serie, parcela, vencimento, liquidado_em, coletado_em)
    VALUES
      (v_item->>'boleto', v_cpf, nullif(v_item->>'semestre',''), nullif(v_item->>'serie',''),
       (v_item->>'parcela')::int, (v_item->>'vencimento')::date, (v_item->>'liquidado_em')::date, now())
    ON CONFLICT (boleto) DO UPDATE SET
      cpf = excluded.cpf, semestre = excluded.semestre, serie = excluded.serie,
      parcela = excluded.parcela, vencimento = excluded.vencimento,
      liquidado_em = excluded.liquidado_em, coletado_em = now();
    v_tit := v_tit + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true, 'cpf', v_cpf, 'aluno_id', v_aluno,
    'telefones_novos', v_tel_novos, 'emails_novos', v_mail_novos,
    'contratos', v_ct, 'titulos', v_tit
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- Leitura para a ficha: matrícula do semestre corrente e dos próximos.
-- ---------------------------------------------------------------------------
create or replace function public.aluno_matricula_semestres(p_aluno_id uuid)
returns table (semestre text, status text, curso text, campus text, turno text,
               valid_from date, valid_to date, cancelado boolean)
language sql
stable
security definer
set search_path to 'public'
as $function$
  SELECT
    extract(year from c.valid_from)::int::text || '/' ||
      CASE WHEN extract(month from c.valid_from) <= 6 THEN '1' ELSE '2' END,
    c.status, c.curso, c.campus, c.turno, c.valid_from, c.valid_to,
    c.cancelado_em IS NOT NULL
  FROM public.prime_contratos c
  JOIN public.alunos a
    ON lpad(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g'), 11, '0') = c.cpf
  WHERE a.id = p_aluno_id
  ORDER BY c.valid_from DESC;
$function$;

commit;
