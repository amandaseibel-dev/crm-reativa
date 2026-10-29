-- O nome do aluno passa a vir do Prime, junto com o resto do cadastro.
--
-- O PROBLEMA. Em 02/09/2026 a base tinha 33 cadastros exibindo o nome de OUTRA
-- pessoa sobre o CPF certo. Descoberto porque "Agnes Cibele Dal'Toé" aparecia
-- com dois cadastros: o segundo era da Aliny Angelica Alves -- CPF, e-mail,
-- telefone e títulos todos dela, só o nome era da Agnes.
--
-- E O DEFEITO NÃO TEM UMA DIREÇÃO SÓ. Medindo os 33 pelo e-mail: em 18 o errado
-- era `alunos.nome`, em 8 era `casos.nome` (invertido), e 7 não davam para
-- julgar. Aplicar "cadastro <- caso" em lote teria corrompido 15 de 33.
-- Pior: comparar as duas tabelas entre si só acha o defeito quando elas
-- DISCORDAM -- quando as duas repetem o mesmo nome errado, ninguém vê. Foi o
-- caso de um cadastro com R$ 122 mil onde nem o nome do cadastro nem o do caso
-- batiam: o Prime disse que era um terceiro, Dyullyan Vargas de Barros, e o
-- e-mail da própria linha (dvargasbarros@) confirmava.
--
-- POR QUE VEM DAQUI E NÃO DE MUTIRÃO MANUAL. Corrigir à mão vira corrente: cada
-- nome devolvido ao dono revela que o nome antigo ocupava ainda outra linha.
-- Foram cinco rodadas e 27 nomes num dia só, e ainda sobrava ponta. Com o nome
-- na rotina, a passada de domingo desfaz a corrente sozinha.
--
-- TRÊS TRAVAS, todas por um motivo concreto:
--
--   1. nome vazio não escreve. Se a Ulbra devolver campo em branco, o cadastro
--      fica como está -- nome errado é ruim, cadastro sem nome é pior.
--   2. CPF repetido não escreve. Dois CPFs da base pertencem, no CRM, a duas
--      pessoas diferentes cada (Thais x Ana Bella, Luiz Ricardo x Marco
--      Antônio). A RPC resolve o aluno por `LIMIT 1`, então escrever ali
--      renomearia uma pessoa com o nome da outra. Esses ficam para a fila
--      `cpf_trocado_conferir`, que é onde a gestão decide.
--   3. só escreve quando muda, ignorando acento e caixa. Sem isso, toda passada
--      reescreveria 17 mil linhas para nada.
--
-- O `socialName` ganha do `fullName` quando existe: é o nome pelo qual a pessoa
-- pede para ser chamada, e é o que o operador lê antes de ligar.

-- Log permanente. A rotina roda toda semana; sem isto, uma troca errada de nome
-- seria invisível e sem volta.
create table if not exists public.prime_nome_corrigido (
  id            bigint generated always as identity primary key,
  aluno_id      uuid not null,
  cpf           text not null,
  nome_anterior text,
  nome_novo     text not null,
  origem        text not null default 'prime-cadastro',
  corrigido_em  timestamptz not null default now()
);
comment on table public.prime_nome_corrigido is
  'Toda troca de nome feita pela rotina do Prime. Guarda o nome anterior para dar marcha a re.';
create index if not exists prime_nome_corrigido_aluno_idx on public.prime_nome_corrigido (aluno_id, corrigido_em desc);
alter table public.prime_nome_corrigido enable row level security;

-- Leitura só para gestão; escrita é da rotina, que roda como service_role e
-- passa por cima do RLS.
drop policy if exists prime_nome_corrigido_gestao_le on public.prime_nome_corrigido;
create policy prime_nome_corrigido_gestao_le on public.prime_nome_corrigido
  for select to authenticated using (public.usuario_e_gestao());

create or replace function public.prime_cadastro_aplicar(p_dados jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_cpf       text := regexp_replace(coalesce(p_dados->>'cpf',''), '\D', '', 'g');
  v_reg       text := nullif(p_dados->>'registration','');
  v_nome      text := nullif(btrim(coalesce(p_dados->>'nome','')), '');
  v_aluno     uuid;
  v_item      jsonb;
  v_tel_novos int := 0;
  v_mail_novos int := 0;
  v_ct        int := 0;
  v_tit       int := 0;
  v_nome_ant  text;
  v_nome_trocado boolean := false;
  v_linhas_cpf int := 0;
  v_r         jsonb;
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' THEN
    RAISE EXCEPTION 'Acesso negado: apenas service_role.' USING ERRCODE='42501';
  END IF;
  IF v_cpf !~ '^[0-9]{11}$' THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'CPF_INVALIDO');
  END IF;

  SELECT count(*) INTO v_linhas_cpf FROM public.alunos
   WHERE lpad(regexp_replace(coalesce(cpf,''), '\D', '', 'g'), 11, '0') = v_cpf;

  SELECT id INTO v_aluno FROM public.alunos
   WHERE lpad(regexp_replace(coalesce(cpf,''), '\D', '', 'g'), 11, '0') = v_cpf
   ORDER BY created_at NULLS LAST LIMIT 1;

  IF v_aluno IS NOT NULL THEN
    -- O NOME. As três travas do cabeçalho estão nesta condição: nome não vazio,
    -- CPF em uma linha só, e diferente do que já está lá (sem acento, sem caixa).
    IF v_nome IS NOT NULL AND v_linhas_cpf = 1 THEN
      SELECT nome INTO v_nome_ant FROM public.alunos WHERE id = v_aluno;

      IF upper(unaccent(coalesce(v_nome_ant,''))) IS DISTINCT FROM upper(unaccent(v_nome)) THEN
        UPDATE public.alunos
           SET nome = v_nome,
               nome_aluno = v_nome,
               nome_normalizado = lower(unaccent(v_nome)),
               nome_referencia = upper(v_nome),
               updated_at = now()
         WHERE id = v_aluno;

        -- O caso também: é o nome que o operador vê na fila. Deixar só o
        -- cadastro certo foi o que criou o ponto cego que escondeu 33 linhas.
        UPDATE public.casos
           SET nome = v_nome,
               nome_aluno = v_nome,
               nome_normalizado = upper(unaccent(v_nome)),
               nome_referencia = upper(v_nome),
               caso_atualizado_por = 'prime-cadastro',
               caso_atualizado_em = now()
         WHERE aluno_id = v_aluno
           AND upper(unaccent(coalesce(nome,''))) IS DISTINCT FROM upper(unaccent(v_nome));

        INSERT INTO public.prime_nome_corrigido (aluno_id, cpf, nome_anterior, nome_novo)
        VALUES (v_aluno, v_cpf, v_nome_ant, v_nome);

        v_nome_trocado := true;
      END IF;
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_dados->'telefones','[]'::jsonb)) LOOP
      v_r := public.aluno_contato_adicionar(v_aluno, 'telefone', v_item #>> '{}', 'prime');
      IF coalesce((v_r->>'novo')::boolean, false) THEN v_tel_novos := v_tel_novos + 1; END IF;
    END LOOP;

    FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_dados->'emails','[]'::jsonb)) LOOP
      v_r := public.aluno_contato_adicionar(v_aluno, 'email', v_item #>> '{}', 'prime');
      IF coalesce((v_r->>'novo')::boolean, false) THEN v_mail_novos := v_mail_novos + 1; END IF;
    END LOOP;
  END IF;

  FOR v_item IN
    SELECT e FROM jsonb_array_elements(coalesce(p_dados->'contratos','[]'::jsonb)) e
     ORDER BY public.prime_contrato_prioridade(e->>'status')
  LOOP
    INSERT INTO public.prime_contratos
      (cpf, registration, valid_from, valid_to, status, tipo, curso, campus, turno, periodo_curso, cancelado_em, coletado_em)
    VALUES
      (v_cpf, coalesce(v_reg,'?'), (v_item->>'valid_from')::date, (v_item->>'valid_to')::date,
       v_item->>'status', v_item->>'tipo', v_item->>'curso', v_item->>'campus', v_item->>'turno',
       (v_item->>'periodo_curso')::int, (v_item->>'cancelado_em')::date, now())
    ON CONFLICT (cpf, registration, valid_from) DO UPDATE SET
      valid_to = excluded.valid_to, status = excluded.status, tipo = excluded.tipo,
      curso = coalesce(excluded.curso, prime_contratos.curso),
      campus = coalesce(excluded.campus, prime_contratos.campus),
      turno = coalesce(excluded.turno, prime_contratos.turno),
      periodo_curso = excluded.periodo_curso, cancelado_em = excluded.cancelado_em,
      coletado_em = now()
    WHERE public.prime_contrato_prioridade(excluded.status)
          >= public.prime_contrato_prioridade(prime_contratos.status);
    v_ct := v_ct + 1;
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_dados->'titulos','[]'::jsonb)) LOOP
    CONTINUE WHEN nullif(v_item->>'boleto','') IS NULL;
    INSERT INTO public.prime_titulo_semestre
      (boleto, cpf, semestre, serie, parcela, vencimento, liquidado_em, carrier_id, coletado_em)
    VALUES
      (v_item->>'boleto', v_cpf, nullif(v_item->>'semestre',''), nullif(v_item->>'serie',''),
       -- NUMERIC, nao int: documento terminado em 990 da parcela 9,9.
       (v_item->>'parcela')::numeric, (v_item->>'vencimento')::date, (v_item->>'liquidado_em')::date,
       nullif(v_item->>'carrier_id','')::int, now())
    ON CONFLICT (boleto) DO UPDATE SET
      cpf = excluded.cpf, semestre = excluded.semestre, serie = excluded.serie,
      parcela = excluded.parcela, vencimento = excluded.vencimento,
      liquidado_em = excluded.liquidado_em,
      -- Nao apaga portador ja conhecido se a coleta vier sem o campo.
      carrier_id = coalesce(excluded.carrier_id, prime_titulo_semestre.carrier_id),
      coletado_em = now();
    v_tit := v_tit + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true, 'cpf', v_cpf, 'aluno_id', v_aluno,
    'nome_trocado', v_nome_trocado,
    'telefones_novos', v_tel_novos, 'emails_novos', v_mail_novos,
    'contratos', v_ct, 'titulos', v_tit
  );
END;
$function$;
