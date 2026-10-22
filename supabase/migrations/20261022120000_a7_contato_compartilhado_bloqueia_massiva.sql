-- A7 — contato compartilhado e contato invalidado NAO recebem acao massiva.
--
-- POR QUE EXISTE. Medido em producao em 22/10/2026: 85 telefones e 57 e-mails
-- aparecem em fichas de CPFs DIFERENTES (251 e 151 fichas). Em outubro, no
-- WhatsApp, 32 numeros receberam mensagem sobre mais de um aluno -- conferido
-- CPF a CPF, 32 de 32 sobre PESSOAS diferentes, 107 fichas, 126 envios. O pior
-- caso e um numero que recebeu 21 mensagens sobre 18 pessoas. Quem atende fica
-- sabendo da divida de um estranho.
--
-- A HIPOTESE "FAMILIA" NAO EXPLICA. Dos telefones compartilhados entre fichas
-- com saldo, 55 de 63 tem SOBRENOMES DIFERENTES, 8 tem o mesmo, e ZERO aparece
-- como telefone_resp1/resp2 de alguem. Por isso NAO ha rotacao de
-- destinatario: rotacionar apenas espalha a exposicao no tempo. O dado nao diz
-- qual dos N CPFs e o dono do contato, e escolher um e apostar.
--
-- SEM FILTRO DE SALDO, DE PROPOSITO. A deteccao varre `alunos` inteira, nao so
-- quem tem saldo. A selecao massiva prioriza por `casos.total_em_aberto`, e
-- 41,8% dos acionados de 08-09/10 tinham `alunos.saldo_total <= 0`; restringir
-- por saldo deixaria passar 23 telefones e 15 e-mails compartilhados.
--
-- BLOQUEIO POR CANAL, NAO POR PESSOA (decisao 2 da gestao). Quem tem telefone
-- compartilhado e e-mail proprio segue sendo cobrado por e-mail: 241 fichas
-- tem algum canal bloqueado, 171 mantem canal alternativo, e so 70 ficam sem
-- nenhum canal (R$ 157.494,93 / 0,52% da base). Sem a regra por canal seriam
-- 241 fichas e R$ 619.896,17 -- tres vezes o custo, sem ganho de protecao.
--
-- BLOQUEIO DE ESTADO, NAO DE LOTE (decisao 7). A guarda equivalente do
-- Preventivo tem escopo de UMA acao (`where o.acao_id = v_acao`) e pegaria 21
-- colisoes / 52 fichas; a exposicao real entre lotes foi 107 fichas / 126
-- envios, porque a recencia de 10 dias espalha as fichas do mesmo numero por
-- lotes diferentes. Aqui a avaliacao le o CADASTRO, nao o conteudo do lote:
-- nao existe janela para configurar, e trocar de lote, de dia, de canal ou de
-- filtro nao contorna.
--
-- AS DUAS PORTAS (decisao 7). `acoes_massivas_universo` (Acoes Massivas) e
-- `buscar_candidatos_acoes_massivas` (tela EnvioGmailLote, que tem apenas 3 das
-- 11 protecoes e nao passa pelo universo). Guarda so no universo deixaria a
-- segunda porta aberta.
--
-- PATCH ANCORADO, NAO REESCRITA. `acoes_massivas_universo` tem 276 linhas e 11
-- motivos cuja PRECEDENCIA importa. Reescrever de memoria ja quebrou tela neste
-- projeto. Os acrescimos vao por `internal.patch_funcao_ancorada`, que recusa o
-- patch se a ancora nao aparecer o numero esperado de vezes -- ou seja, se a
-- funcao em producao tiver mudado, a migration FALHA em vez de corromper.
--
-- NADA FINANCEIRO (decisao 8). Zero DML sobre dado existente, zero backfill,
-- nenhum valor, saldo, acordo, pagamento ou baixa tocado. A ordem de prioridade
-- da previa fica intacta: nenhuma inversao por saldo, nenhum sorteio.

-- ---------------------------------------------------------------------------
-- 1. Placeholder nao e colisao: e ausencia de contato (regra R6)
-- ---------------------------------------------------------------------------
-- Um contato de preenchimento artificial nao e de ninguem, entao nao ha
-- terceiro a proteger e ele nao deve inflar a contagem de compartilhamento.
-- Continua caindo em `contato_indisponivel`, o motivo que ja existia.
create or replace function public.contato_e_placeholder(p_canal text, p_contato text)
returns boolean
language sql
immutable
set search_path to 'public'
as $$
  select case
    when nullif(btrim(coalesce(p_contato, '')), '') is null then true
    when upper(coalesce(p_canal, '')) = 'TELEFONE' then
      p_contato ~ '^(.)\1+$'
      or p_contato like '0000%'
      or p_contato like '9999%'
      or length(p_contato) not in (10, 11)
    when upper(coalesce(p_canal, '')) = 'EMAIL' then
      p_contato !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
      or split_part(p_contato, '@', 2) in ('example.com', 'example.org', 'teste.com',
                                           'email.com', 'sememail.com', 'naotem.com')
    else false
  end;
$$;

comment on function public.contato_e_placeholder(text, text) is
  'A7/R6: contato de preenchimento artificial. Nao conta como compartilhado e segue caindo em contato_indisponivel.';

-- ---------------------------------------------------------------------------
-- 2. Contato normalizado, por ficha e por canal (regra R1)
-- ---------------------------------------------------------------------------
-- A normalizacao e a MESMA que a previa aplica em `tel_dig` / `email_t`, para
-- que guarda e envio nunca divirjam.
--
-- NUNCA INVENTAR O NONO DIGITO. Sao 1.322 fichas com 10 digitos e 114 com 11
-- digitos sem o 9 na posicao esperada. Normalizar "10 digitos" para "11 com 9"
-- criaria colisao falsa e poderia apontar para o numero de OUTRA pessoa.
-- Comparacao por digitos como estao, sempre.
create or replace view public.vw_contato_normalizado as
select a.id as aluno_id,
       -- ficha sem CPF conta como pessoa propria: `count(distinct)` ignora NULL,
       -- e duas fichas sem CPF no mesmo numero NAO sao a mesma pessoa.
       coalesce(nullif(regexp_replace(coalesce(a.cpf, ''), '\D', '', 'g'), ''),
                'SEM_CPF:' || a.id::text) as pessoa,
       'TELEFONE'::text as canal,
       nullif(regexp_replace(coalesce(a.telefone, ''), '\D', '', 'g'), '') as contato
  from public.alunos a
union all
select a.id,
       coalesce(nullif(regexp_replace(coalesce(a.cpf, ''), '\D', '', 'g'), ''),
                'SEM_CPF:' || a.id::text),
       'EMAIL'::text,
       nullif(lower(btrim(coalesce(a.email, ''))), '')
  from public.alunos a;

comment on view public.vw_contato_normalizado is
  'A7/R1: contato de cada ficha por canal, normalizado como a previa normaliza. Base INTEIRA, sem filtro de saldo -- ver cabecalho da migration.';

-- ---------------------------------------------------------------------------
-- 3. Contato compartilhado entre pessoas diferentes (regra R2)
-- ---------------------------------------------------------------------------
-- Duas fichas do MESMO CPF nao sao colisao: e duplicidade de cadastro. A
-- colisao e entre PESSOAS, por isso a contagem e de `pessoa` distinta.
create or replace view public.vw_contato_compartilhado as
select n.canal,
       n.contato,
       count(*)::int as fichas,
       count(distinct n.pessoa)::int as pessoas,
       -- o limite de 5 so PRIORIZA a revisao; nao cria faixa segura (R5):
       -- 2 pessoas ja bloqueia.
       (count(distinct n.pessoa) >= 5) as revisao_prioritaria
  from public.vw_contato_normalizado n
 where n.contato is not null
   and not public.contato_e_placeholder(n.canal, n.contato)
 group by n.canal, n.contato
having count(distinct n.pessoa) > 1;

comment on view public.vw_contato_compartilhado is
  'A7/R2: contatos em fichas de pessoas diferentes. >= 5 pessoas marca revisao prioritaria (R5), mas 2 ja bloqueia.';

-- ---------------------------------------------------------------------------
-- 4. Contato invalidado em aluno_contatos (regra R8a / decisao 3)
-- ---------------------------------------------------------------------------
-- O mecanismo JA EXISTIA e estava DESLIGADO: `aluno_contatos` tem
-- valido / invalidado_em / invalidado_por_email / motivo_invalidacao, com
-- 20.440 telefones e 12.875 e-mails, e foi usado UMA vez -- com o motivo
-- literal "nao e a pessoa". Mas a previa le `alunos.telefone` e `alunos.email`
-- direto da ficha e nunca consultou `aluno_contatos`, logo invalidar um contato
-- nao tinha efeito nenhum sobre o envio. Esta view liga o campo ao envio.
create or replace view public.vw_contato_invalidado as
select ac.aluno_id,
       case when lower(coalesce(ac.tipo, '')) = 'telefone' then 'TELEFONE' else 'EMAIL' end as canal,
       case when lower(coalesce(ac.tipo, '')) = 'telefone'
            then nullif(regexp_replace(coalesce(ac.valor, ''), '\D', '', 'g'), '')
            else nullif(lower(btrim(coalesce(ac.valor, ''))), '')
       end as contato,
       ac.motivo_invalidacao,
       ac.invalidado_em,
       ac.invalidado_por_email
  from public.aluno_contatos ac
 where ac.valido is not true
   and lower(coalesce(ac.tipo, '')) in ('telefone', 'email');

comment on view public.vw_contato_invalidado is
  'A7/R8a: contatos marcados como invalidos em aluno_contatos, normalizados para casar com a ficha.';

-- ---------------------------------------------------------------------------
-- 5. O bloqueio, por aluno e canal
-- ---------------------------------------------------------------------------
-- Uma linha por (aluno, canal) APENAS quando aquele canal esta bloqueado.
-- Ausencia de linha = canal livre. Assim o join no universo e um left join
-- simples, sem EXISTS correlacionado -- que neste banco ja custou 35 s dentro
-- de CTE materializado.
create or replace view public.vw_contato_bloqueio as
select n.aluno_id,
       n.canal,
       n.contato,
       (i.aluno_id is not null) as invalidado,
       (s.contato is not null) as compartilhado,
       coalesce(s.pessoas, 0) as pessoas_no_contato,
       coalesce(s.revisao_prioritaria, false) as revisao_prioritaria,
       -- invalidado tem precedencia: e declaracao humana explicita
       case when i.aluno_id is not null then 'contato_invalidado'
            else 'contato_compartilhado'
       end as motivo
  from public.vw_contato_normalizado n
  left join public.vw_contato_compartilhado s
         on s.canal = n.canal and s.contato = n.contato
  left join public.vw_contato_invalidado i
         on i.aluno_id = n.aluno_id and i.canal = n.canal and i.contato = n.contato
 where n.contato is not null
   and (s.contato is not null or i.aluno_id is not null);

comment on view public.vw_contato_bloqueio is
  'A7: (aluno, canal) bloqueado para acao massiva. Sem linha = canal livre. Estado do cadastro, nao do lote (R7).';

-- ---------------------------------------------------------------------------
-- 6. Quem pode revalidar / liberar (decisao 4)
-- ---------------------------------------------------------------------------
-- "Revalidacao ou liberacao devera ser exclusiva do Administrativo ou da
-- supervisao."
--
-- Conferido em 22/10/2026: os 3 e-mails de `usuario_e_gestao()` sao exatamente
-- os perfis administrativo, gerencia e supervisor. Mesmo assim o portao olha o
-- PERFIL em `usuarios`, nao uma lista de e-mails: assim continua valendo se a
-- pessoa do Administrativo ou a supervisao mudar de e-mail ou for substituida.
-- `usuario_e_gestao()` fica como alternativa, nao como unica fonte.
--
-- `coalesce(..., false)` de proposito: usuario inexistente da FALSE, nao NULL.
-- Neste projeto ja houve guarda de operador que era letra morta por devolver
-- NULL em vez de falso.
create or replace function public.usuario_pode_revalidar_contato()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(
           (select u.ativo and lower(coalesce(u.perfil, '')) in ('administrativo', 'supervisor')
              from public.usuarios u
             where lower(u.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
             limit 1),
           false)
      or public.usuario_e_gestao();
$$;

comment on function public.usuario_pode_revalidar_contato() is
  'A7/decisao 4: Administrativo ou supervisao (por perfil em usuarios), ou gestao. Revalidar/liberar contato e exclusivo deles.';

-- ---------------------------------------------------------------------------
-- 7. Fila de revisao cadastral (regra R5 / decisao 5)
-- ---------------------------------------------------------------------------
-- Responsabilidade do Administrativo, acompanhamento da supervisao.
-- Funcao, e nao view aberta, porque a fila expoe contato (dado pessoal) e o
-- acesso fica atras do portao de permissao.
create or replace function public.contato_fila_revisao(p_canal text default null,
                                                       p_limite integer default 200)
returns table(canal text, contato text, pessoas integer, fichas integer,
              revisao_prioritaria boolean, alunos jsonb)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not public.usuario_pode_revalidar_contato() then
    raise exception 'Acesso negado: fila de revisao cadastral restrita ao Administrativo e a supervisao.'
      using errcode = '42501';
  end if;

  return query
    select s.canal, s.contato, s.pessoas, s.fichas, s.revisao_prioritaria,
           coalesce(jsonb_agg(jsonb_build_object(
             'aluno_id', n.aluno_id,
             'nome', a.nome,
             -- mostra se bloquear este canal deixa a ficha sem canal nenhum:
             -- e o que separa "ainda cobravel" de "parado ate a revisao"
             'tem_canal_alternativo', exists (
                select 1 from public.vw_contato_normalizado n2
                 where n2.aluno_id = n.aluno_id
                   and n2.canal <> s.canal
                   and n2.contato is not null
                   and not public.contato_e_placeholder(n2.canal, n2.contato)
                   and not exists (select 1 from public.vw_contato_bloqueio b2
                                    where b2.aluno_id = n2.aluno_id
                                      and b2.canal = n2.canal)
             )
           ) order by a.nome), '[]'::jsonb)
      from public.vw_contato_compartilhado s
      join public.vw_contato_normalizado n
        on n.canal = s.canal and n.contato = s.contato
      join public.alunos a on a.id = n.aluno_id
     where p_canal is null or upper(btrim(p_canal)) = s.canal
     group by s.canal, s.contato, s.pessoas, s.fichas, s.revisao_prioritaria
     order by s.revisao_prioritaria desc, s.pessoas desc, s.canal, s.contato
     limit least(greatest(coalesce(p_limite, 200), 1), 1000);
end;
$$;

comment on function public.contato_fila_revisao(text, integer) is
  'A7/decisao 5: fila de revisao cadastral dos contatos compartilhados. Administrativo e supervisao apenas. Prioritarios (>= 5 pessoas) primeiro.';

-- ---------------------------------------------------------------------------
-- 8. Operador sinaliza contato incorreto (decisao 4)
-- ---------------------------------------------------------------------------
-- Qualquer operador logado pode SINALIZAR, com motivo obrigatorio e autoria
-- registrada. LIBERAR e exclusivo do Administrativo/supervisao (secao 9).
-- Reaproveita `aluno_contatos`: nao cria tabela nova.
create or replace function public.contato_sinalizar_incorreto(p_aluno_id uuid,
                                                              p_canal text,
                                                              p_motivo text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_autor text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_canal text := upper(btrim(coalesce(p_canal, '')));
  v_motivo text := nullif(btrim(coalesce(p_motivo, '')), '');
  v_contato text;
  v_tipo text;
  v_id uuid;
begin
  if v_autor = '' then
    raise exception 'Acesso negado: sinalizar contato exige sessao autenticada com e-mail.'
      using errcode = '42501';
  end if;
  if v_canal not in ('TELEFONE', 'EMAIL') then
    raise exception 'Canal invalido: %', p_canal using errcode = '22023';
  end if;
  if v_motivo is null then
    raise exception 'Motivo obrigatorio ao sinalizar contato incorreto.' using errcode = '22023';
  end if;

  v_tipo := lower(v_canal);

  select n.contato into v_contato
    from public.vw_contato_normalizado n
   where n.aluno_id = p_aluno_id and n.canal = v_canal;

  if v_contato is null then
    raise exception 'Aluno % nao tem contato de % para sinalizar.', p_aluno_id, v_canal
      using errcode = 'P0002';
  end if;

  -- decisao 8: preservar historico. Nao apaga nem sobrescreve o contato da
  -- ficha; marca invalido o registro existente, ou cria o registro da marca.
  update public.aluno_contatos ac
     set valido = false,
         invalidado_em = now(),
         invalidado_por_email = v_autor,
         motivo_invalidacao = v_motivo
   where ac.aluno_id = p_aluno_id
     and lower(coalesce(ac.tipo, '')) = v_tipo
     and case when v_tipo = 'telefone'
              then nullif(regexp_replace(coalesce(ac.valor, ''), '\D', '', 'g'), '')
              else nullif(lower(btrim(coalesce(ac.valor, ''))), '') end = v_contato
  returning ac.id into v_id;

  if v_id is null then
    insert into public.aluno_contatos
      (aluno_id, tipo, valor, valor_exibicao, origem, principal, valido,
       invalidado_em, invalidado_por_email, motivo_invalidacao, criado_por_email)
    values (p_aluno_id, v_tipo, v_contato, v_contato, 'SINALIZACAO_OPERADOR', false, false,
            now(), v_autor, v_motivo, v_autor)
    returning id into v_id;
  end if;

  return jsonb_build_object('ok', true, 'contato_id', v_id, 'canal', v_canal,
                            'motivo', v_motivo, 'autor', v_autor,
                            'liberacao', 'exclusiva do Administrativo ou da supervisao');
end;
$$;

comment on function public.contato_sinalizar_incorreto(uuid, text, text) is
  'A7/decisao 4: operador marca contato como incorreto, com motivo e autoria. Passa a bloquear o canal na acao massiva. Liberar e so do Administrativo/supervisao.';

-- ---------------------------------------------------------------------------
-- 9. Revalidar / liberar -- Administrativo ou supervisao apenas (decisao 4)
-- ---------------------------------------------------------------------------
create or replace function public.contato_revalidar(p_contato_id uuid,
                                                    p_motivo text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_autor text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_motivo text := nullif(btrim(coalesce(p_motivo, '')), '');
  v_aluno uuid;
  v_tipo text;
begin
  if not public.usuario_pode_revalidar_contato() then
    raise exception 'Acesso negado: revalidar contato e exclusivo do Administrativo ou da supervisao.'
      using errcode = '42501';
  end if;
  if v_motivo is null then
    raise exception 'Motivo obrigatorio ao revalidar contato.' using errcode = '22023';
  end if;

  update public.aluno_contatos ac
     set valido = true,
         invalidado_em = null,
         invalidado_por_email = null,
         -- decisao 8: preserva a trilha. Registra quem liberou e por que, sem
         -- apagar o motivo anterior.
         motivo_invalidacao = 'LIBERADO por ' || v_autor || ' em ' ||
                              to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') ||
                              ': ' || v_motivo ||
                              ' | anterior: ' || coalesce(ac.motivo_invalidacao, '-')
   where ac.id = p_contato_id
  returning ac.aluno_id, ac.tipo into v_aluno, v_tipo;

  if v_aluno is null then
    raise exception 'Contato % nao encontrado.', p_contato_id using errcode = 'P0002';
  end if;

  return jsonb_build_object('ok', true, 'contato_id', p_contato_id, 'aluno_id', v_aluno,
                            'tipo', v_tipo, 'liberado_por', v_autor, 'motivo', v_motivo);
end;
$$;

comment on function public.contato_revalidar(uuid, text) is
  'A7/decisao 4: libera contato invalidado. Exclusivo do Administrativo ou da supervisao. Preserva a trilha do motivo anterior.';

-- ---------------------------------------------------------------------------
-- 10. GRANTS
-- ---------------------------------------------------------------------------
-- LICAO JA PAGA NESTE BANCO: toda funcao nova herda EXECUTE de PUBLIC, e foi
-- por essa heranca que `prime_aluno_no_juridico` ficou alcancavel SEM LOGIN.
-- Por isso cada funcao nova aqui tem o EXECUTE de PUBLIC revogado e o papel
-- concedido explicitamente.
revoke all on function public.contato_e_placeholder(text, text) from public;
revoke all on function public.usuario_pode_revalidar_contato() from public;
revoke all on function public.contato_fila_revisao(text, integer) from public;
revoke all on function public.contato_sinalizar_incorreto(uuid, text, text) from public;
revoke all on function public.contato_revalidar(uuid, text) from public;

grant execute on function public.usuario_pode_revalidar_contato() to authenticated;
grant execute on function public.contato_fila_revisao(text, integer) to authenticated;
grant execute on function public.contato_sinalizar_incorreto(uuid, text, text) to authenticated;
grant execute on function public.contato_revalidar(uuid, text) to authenticated;
-- contato_e_placeholder e plumbing interno: fica so para o owner.

-- As views NAO sao concedidas a authenticated, de proposito. Elas expoem
-- telefone e e-mail, e todas as funcoes que as leem sao SECURITY DEFINER com
-- owner postgres -- logo leem como owner, sem precisar de grant. Sem grant o
-- PostgREST nao publica, e dado pessoal nao fica consultavel com a chave que
-- viaja no bundle do front.
revoke all on public.vw_contato_normalizado from authenticated, anon;
revoke all on public.vw_contato_compartilhado from authenticated, anon;
revoke all on public.vw_contato_invalidado from authenticated, anon;
revoke all on public.vw_contato_bloqueio from authenticated, anon;

-- ---------------------------------------------------------------------------
-- 11. PORTA 1 -- acoes_massivas_universo respeita o bloqueio
-- ---------------------------------------------------------------------------
-- Tres acrescimos ancorados. Se qualquer ancora nao aparecer o numero exato de
-- vezes, a migration FALHA -- e isso e o desejado: significa que a funcao em
-- producao mudou e o patch precisa de revisao.

-- (11.a) flags: calcula o bloqueio por canal, com LEFT JOIN e nao EXISTS
--        correlacionado. A ancora e a ultima coluna do SELECT mais o FROM,
--        para acrescentar colunas e joins numa so troca.
select internal.patch_funcao_ancorada(
  'public', 'acoes_massivas_universo',
$ancora$           (coalesce(k.valor_caso, 0) < v_min
            or (v_max is not null and coalesce(k.valor_caso, 0) > v_max)) as f_val
      from cls k$ancora$,
$novo$           (coalesce(k.valor_caso, 0) < v_min
            or (v_max is not null and coalesce(k.valor_caso, 0) > v_max)) as f_val,
           -- A7: contato compartilhado entre pessoas, ou marcado invalido.
           -- LEFT JOIN e nao EXISTS correlacionado: neste banco um EXISTS
           -- correlacionado dentro de CTE materializado ja custou 35 s.
           (bt.aluno_id is not null) as f_tel_bl, bt.motivo as mot_tel_bl,
           (be.aluno_id is not null) as f_mail_bl, be.motivo as mot_mail_bl
      from cls k
      left join public.vw_contato_bloqueio bt
             on bt.aluno_id = k.id and bt.canal = 'TELEFONE'
      left join public.vw_contato_bloqueio be
             on be.aluno_id = k.id and be.canal = 'EMAIL'$novo$,
  1);

-- (11.b) enc: decide pelo canal QUE ESTE LOTE USA. Por canal, de proposito --
--        telefone compartilhado nao impede o e-mail proprio (decisao 2).
--        Com canal nulo o universo nao envia, so conta, e nada e bloqueado.
--
--        A ancora e a PRIMEIRA linha do `case` do f_ctt, e as colunas novas
--        entram ANTES dele. Motivo: producao e o arquivo de migration deste
--        repositorio divergem no FIM dessa expressao -- producao tem
--        `as f_ctt,` (com virgula, porque ainda vem `f_giro` depois) e o
--        arquivo tem `as f_ctt` sem virgula. Ancorar no fim funcionaria em um
--        e falharia no outro. Esta linha e identica nos dois, entao o patch
--        vale para o banco de producao E para a bancada de teste.
select internal.patch_funcao_ancorada(
  'public', 'acoes_massivas_universo',
$ancora$           case when v_canal = 'WHATSAPP' then not z.f_tel$ancora$,
$novo$           -- A7: bloqueio do canal deste lote.
           case when v_canal = 'WHATSAPP' then z.f_tel_bl
                when v_canal = 'EMAIL' then z.f_mail_bl
                else false end as f_ctt_bl,
           case when v_canal = 'WHATSAPP' then z.mot_tel_bl
                when v_canal = 'EMAIL' then z.mot_mail_bl
                else null end as mot_ctt_bl,
           case when v_canal = 'WHATSAPP' then not z.f_tel$novo$,
  1);

-- (11.c) os DOIS cascatas de motivo (`mot` e `mot_st`), identicas nesse trecho.
--        p_ocorrencias = 2 de proposito: o acrescimo vale nas duas.
--        Entra DEPOIS de `contato_indisponivel` para que todo caso que hoje tem
--        motivo continue com exatamente o mesmo motivo -- A7 so acrescenta.
select internal.patch_funcao_ancorada(
  'public', 'acoes_massivas_universo',
$ancora$                when e.f_ctt then 'contato_indisponivel'
                when e.f_val then 'valor_fora_da_faixa'$ancora$,
$novo$                when e.f_ctt then 'contato_indisponivel'
                when e.f_ctt_bl then e.mot_ctt_bl
                when e.f_val then 'valor_fora_da_faixa'$novo$,
  2);

-- ---------------------------------------------------------------------------
-- 12. PORTA 2 -- buscar_candidatos_acoes_massivas (tela EnvioGmailLote)
-- ---------------------------------------------------------------------------
-- Esta funcao NAO passa pelo universo e tem apenas 3 das 11 protecoes. Sem a
-- guarda aqui, trocar de porta contornaria o bloqueio (decisao 7).

-- (12.a) exclui quem tem o E-MAIL bloqueado -- e o canal que esta tela usa.
--        NOT EXISTS e nao NOT IN: com NOT IN, um unico NULL na subconsulta
--        tornaria a condicao NULL e a linha sumiria em silencio.
select internal.patch_funcao_ancorada(
  'public', 'buscar_candidatos_acoes_massivas',
$ancora$    AND public.aluno_em_confirmacao_pagamento(a.id::text) IS NULL$ancora$,
$novo$    AND public.aluno_em_confirmacao_pagamento(a.id::text) IS NULL
    -- A7: segunda porta. Esta tela envia E-MAIL pelo Gmail do operador.
    AND NOT EXISTS (
      SELECT 1 FROM public.vw_contato_bloqueio b
       WHERE b.aluno_id = a.id AND b.canal = 'EMAIL'
    )$novo$,
  1);

-- (12.b) telefone bloqueado sai NULO. Hoje so a tela de e-mail usa esta
--        funcao; se amanha alguem a usar para WhatsApp, nao recebe numero
--        compartilhado nem invalidado.
select internal.patch_funcao_ancorada(
  'public', 'buscar_candidatos_acoes_massivas',
$ancora$  SELECT a.id, a.nome, a.telefone, a.email, a.data_ultimo_acionamento,$ancora$,
$novo$  SELECT a.id, a.nome,
         -- A7: telefone bloqueado nao sai desta funcao.
         CASE WHEN EXISTS (SELECT 1 FROM public.vw_contato_bloqueio b
                            WHERE b.aluno_id = a.id AND b.canal = 'TELEFONE')
              THEN NULL ELSE a.telefone END,
         a.email, a.data_ultimo_acionamento,$novo$,
  1);

-- ---------------------------------------------------------------------------
-- 13. ROTULO DOS MOTIVOS NOVOS
-- ---------------------------------------------------------------------------
-- `acoes_massivas_motivo_texto` tem `else p_motivo`, entao sem este patch os
-- motivos novos apareceriam como codigo cru na tela e no resumo do lote.
-- O texto evita expor o contato e evita acusar o aluno: a dificuldade e de
-- cadastro, nao de comportamento.
select internal.patch_funcao_ancorada(
  'public', 'acoes_massivas_motivo_texto',
$ancora$    when 'valor_fora_da_faixa'   then 'Valor em aberto fora da faixa selecionada'$ancora$,
$novo$    when 'contato_compartilhado' then 'Outra pessoa com dívida usa o mesmo contato — em revisão cadastral'
    when 'contato_invalidado'    then 'Contato marcado como incorreto — liberação pelo Administrativo'
    when 'valor_fora_da_faixa'   then 'Valor em aberto fora da faixa selecionada'$novo$,
  1);
