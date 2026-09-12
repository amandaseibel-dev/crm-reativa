-- ITEM 1. Nome deixa de decidir o aluno do pagamento.
--
-- Regra nova, em ordem: CPF confiavel -> boleto exato -> prefixo UNICO ->
-- numero_ulbra UNICO -> SEM VINCULO (vai para fila de excecao com o nome
-- apenas como SUGESTAO).
--
-- Por que nessa ordem, medido em prod 2026-09-12:
--   parcelas.boleto tem indice UNIQUE (ux_parcelas_boleto) -> boleto exato e
--   prova. O prefixo de 6 digitos NAO e prova sempre: 183 prefixos apontam
--   para 2+ acordos (1.133 parcelas, 249 pagamentos, R$ 746.893,69). Entao o
--   prefixo so automatiza quando for inequivocamente unico; ambiguo vai para
--   excecao.
--
-- Simulacao antes de trocar (nao e estimativa, e contagem):
--   ultima importacao (proje.xlsx, 54 pagtos): 7 por boleto, 25 por numero_ulbra,
--                                              22 para a fila (40,7%)
--   ultimos 7 dias (303):  3 CPF, 123 boleto, 87 ulbra, 90 fila (29,7%)
--   historico (8.999):  3.271 CPF, 1.794 boleto, 29 prefixo, 90 ulbra,
--                       3.815 fila (42,4%) -- e 54 pagamentos trocariam de
--                       aluno, ou seja: sao os que o nome atribuiu errado.
--
-- O historico NAO e desvinculado. A regra vale para INSERT novo.

create table if not exists public.fila_pagamento_sem_vinculo (
  id                  bigserial primary key,
  pagamento_id        uuid not null references public.pagamentos(id) on delete cascade,
  importacao_id       uuid,
  arquivo_nome        text,
  boleto              text,
  data_pagamento      date,
  valor_pago          numeric,
  valor_honorario     numeric,
  nome_recebido       text,
  cpf_recebido        text,
  matricula_recebida  text,
  -- apenas SUGESTOES. Nenhuma delas vincula nada sozinha.
  sugestoes           jsonb not null default '[]'::jsonb,
  motivo              text not null,
  detectado_em        timestamptz not null default now(),
  -- decisao humana
  decisao             text check (decisao in ('VINCULADO','DESCARTADO','AGUARDANDO_TERCEIRO')),
  aluno_escolhido_id  uuid references public.alunos(id) on delete set null,
  decidido_por        text,
  decidido_em         timestamptz,
  observacao          text,
  constraint fila_pag_sem_vinculo_unico unique (pagamento_id)
);
create index if not exists ix_fila_pag_sem_vinculo_pendente
  on public.fila_pagamento_sem_vinculo (detectado_em desc) where decisao is null;
alter table public.fila_pagamento_sem_vinculo enable row level security;

comment on table public.fila_pagamento_sem_vinculo is
  'Pagamento que entrou sem identificador financeiro suficiente. Nome aparece so como sugestao; nada aqui vincula automaticamente. Nenhum pagamento e descartado -- a linha em pagamentos continua existindo.';

-- BEFORE INSERT: vincula SO por identificador financeiro.
create or replace function public._pagamento_vincula_por_identificador_financeiro()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare
  v_cpf text; v_pref text; v_id uuid; v_n int;
begin
  if new.aluno_id is not null then return new; end if;

  -- 1) CPF confiavel: mesma expressao do indice idx_alunos_cpf_normalizado
  v_cpf := nullif(regexp_replace(coalesce(new.cpf,''), '\D', '', 'g'), '');
  if v_cpf is not null and length(v_cpf) between 10 and 11 then
    select a.id into v_id from public.alunos a
     where lpad(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g'), 11, '0') = lpad(v_cpf, 11, '0')
     limit 1;
    if v_id is not null then new.aluno_id := v_id; return new; end if;
  end if;

  if new.numero_parcela_completo is null then return new; end if;

  -- 2) boleto exato: parcelas.boleto e UNIQUE, entao isto e prova
  select a.aluno_id into v_id
    from public.parcelas p join public.acordos a on a.id = p.acordo_id
   where p.boleto = new.numero_parcela_completo limit 1;
  if v_id is not null then new.aluno_id := v_id; return new; end if;

  -- 3) prefixo do boleto, SO se apontar para um unico acordo.
  --    O LIKE usa o indice ux_parcelas_boleto.
  if length(new.numero_parcela_completo) = 11 then
    v_pref := substring(new.numero_parcela_completo, 2, 6);

    select count(distinct p.acordo_id), min(a.aluno_id::text)::uuid into v_n, v_id
      from public.parcelas p join public.acordos a on a.id = p.acordo_id
     where p.boleto like '5' || v_pref || '%';
    if v_n = 1 and v_id is not null then new.aluno_id := v_id; return new; end if;

    -- 4) numero_ulbra, SO se unico
    select count(*), min(a.aluno_id::text)::uuid into v_n, v_id
      from public.acordos a
     where a.numero_ulbra is not null
       and lpad(a.numero_ulbra, 6, '0') = v_pref;
    if v_n = 1 and v_id is not null then new.aluno_id := v_id; return new; end if;
  end if;

  -- nada conclusivo: fica SEM VINCULO. O AFTER enfileira.
  return new;
end;
$fn$;

-- AFTER INSERT: o que ficou sem vinculo vai para a fila, com sugestoes por nome.
create or replace function public._pagamento_enfileira_sem_vinculo()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare
  v_sug jsonb := '[]'::jsonb; v_motivo text; v_pref text; v_amb boolean := false; v_arq text;
begin
  if new.aluno_id is not null then return null; end if;

  if new.numero_parcela_completo is null then
    v_motivo := 'sem CPF valido e sem numero de boleto no arquivo';
  elsif length(new.numero_parcela_completo) = 11 then
    v_pref := substring(new.numero_parcela_completo, 2, 6);
    select count(distinct p.acordo_id) > 1 into v_amb
      from public.parcelas p where p.boleto like '5' || v_pref || '%';
    if coalesce(v_amb,false) then
      v_motivo := 'prefixo do boleto ' || v_pref || ' aponta para mais de um acordo: ambiguo por desenho';
    else
      v_motivo := 'boleto ' || new.numero_parcela_completo || ' nao existe em parcelas e o acordo ' || v_pref || ' nao esta no CRM';
    end if;
  else
    v_motivo := 'boleto fora do padrao de 11 digitos: ' || new.numero_parcela_completo;
  end if;

  -- SUGESTOES por nome. Nunca aplicadas: servem para a pessoa escolher.
  if coalesce(trim(new.aluno_nome),'') <> '' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'aluno_id', a.id, 'nome', a.nome, 'cpf_mascarado', a.cpf_mascarado,
             'matricula', a.matricula, 'tem_acordo_ativo',
             exists (select 1 from public.acordos ac where ac.aluno_id = a.id and ac.status='ATIVO'))), '[]'::jsonb)
      into v_sug
      from public.alunos a
     where coalesce(trim(a.nome),'') <> ''
       and translate(upper(regexp_replace(trim(a.nome), '\s+', ' ', 'g')),
                     'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC')
         = translate(upper(regexp_replace(trim(new.aluno_nome), '\s+', ' ', 'g')),
                     'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC');
  end if;

  select i.arquivo_nome into v_arq from public.importacoes i where i.id = new.importacao_id;

  insert into public.fila_pagamento_sem_vinculo
    (pagamento_id, importacao_id, arquivo_nome, boleto, data_pagamento, valor_pago,
     valor_honorario, nome_recebido, cpf_recebido, matricula_recebida, sugestoes, motivo)
  values (new.id, new.importacao_id, v_arq, new.numero_parcela_completo, new.data_pagamento,
          new.valor_pago, new.valor_honorario, new.aluno_nome, new.cpf, new.matricula, v_sug,
          v_motivo || case when jsonb_array_length(v_sug) > 0
                           then ' | ' || jsonb_array_length(v_sug)::text || ' sugestao(oes) por nome, para conferencia humana'
                           else ' | nenhum nome parecido na base' end)
  on conflict (pagamento_id) do nothing;

  return null;
end;
$fn$;

-- A TROCA. O gatilho antigo sai; a funcao antiga fica no banco para rollback.
drop trigger if exists trg_pagamento_vincula_aluno on public.pagamentos;

create trigger trg_pagamento_vincula_identificador
  before insert on public.pagamentos
  for each row execute function public._pagamento_vincula_por_identificador_financeiro();

create trigger trg_pagamento_enfileira_sem_vinculo
  after insert on public.pagamentos
  for each row execute function public._pagamento_enfileira_sem_vinculo();

-- Licao da Fase 2A: nada novo nasce chamavel por anon/authenticated.
revoke all on function public._pagamento_vincula_por_identificador_financeiro() from public, anon, authenticated;
revoke all on function public._pagamento_enfileira_sem_vinculo() from public, anon, authenticated;
