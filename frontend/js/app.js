/* Baymax - utilitários compartilhados: sessão, requisições autenticadas e navbar */
(function (global) {
  "use strict";

  const CHAVE_SESSAO = "usuario";
  const CHAVE_TEMA = "baymax-tema-v2";
  const ESTOQUE_BAIXO = 10; // até esta quantidade o item aparece como "estoque baixo"
  let controleTema;
  let temaAtual = "light";

  const SETORES = {
    atendimento: "Atendimento",
    triagem: "Triagem",
    medico: "Médico",
    enfermagem: "Enfermagem",
    tecnico_enfermagem: "Técnico de enfermagem",
    laboratorista: "Laboratório",
    medicacao: "Medicação",
    almoxarifado: "Almoxarifado",
    centro_cirurgico: "Centro cirúrgico",
    gestor: "Gestão hospitalar",
    alta: "Alta",
    admin: "Administrador"
  };

  const PAGINA_INICIAL = {
    atendimento: "atendimento.html",
    triagem: "triagem.html",
    medico: "medico.html",
    enfermagem: "leitos.html",
    tecnico_enfermagem: "enfermagem.html",
    laboratorista: "laboratorio.html",
    medicacao: "medicacoes.html",
    almoxarifado: "almoxerifado.html",
    centro_cirurgico: "cirurgias.html",
    gestor: "relatorios.html",
    alta: "alta.html",
    admin: "admin.html"
  };

  // tipos = setores que enxergam o item (o administrador enxerga todos)
  const MENU = [
    { href: "dashboard.html", rotulo: "Visão geral", icone: "⌂", tipos: Object.keys(SETORES) },
    { href: "perfil.html", rotulo: "Meu perfil", icone: "●", tipos: Object.keys(SETORES) },
    { href: "admin.html", rotulo: "Painel", icone: "▦", tipos: [] },
    { href: "pacientes.html", rotulo: "Pacientes", icone: "●", tipos: ["atendimento", "medico", "triagem"] },
    { href: "agenda.html", rotulo: "Agenda", icone: "▦", tipos: ["atendimento", "medico"] },
    { href: "leitos.html", rotulo: "Internação e leitos", icone: "▤", tipos: ["medico", "enfermagem", "tecnico_enfermagem"] },
    { href: "enfermagem.html", rotulo: "Enfermagem", icone: "✚", tipos: ["medico", "enfermagem", "tecnico_enfermagem"] },
    { href: "laboratorio.html", rotulo: "Laboratório", icone: "⚗", tipos: ["medico", "laboratorista", "enfermagem", "tecnico_enfermagem"] },
    { href: "cirurgias.html", rotulo: "Centro cirúrgico", icone: "✚", tipos: ["medico", "centro_cirurgico"] },
    { href: "relatorios.html", rotulo: "Gestão hospitalar", icone: "▥", tipos: ["gestor"] },
    { href: "atendimento.html", rotulo: "Atendimento", icone: "＋", tipos: ["atendimento"] },
    { href: "triagem.html", rotulo: "Triagem", icone: "⌕", tipos: ["triagem"] },
    { href: "medico.html", rotulo: "Médico", icone: "✚", tipos: ["medico"] },
    { href: "prontuario.html", rotulo: "Prontuário", icone: "▤", tipos: ["medico", "triagem"] },
    { href: "medicacoes.html", rotulo: "Farmácia", icone: "✚", tipos: ["medicacao"] },
    { href: "almoxerifado.html", rotulo: "Almoxarifado", icone: "▣", tipos: ["medicacao", "almoxarifado"] },
    { href: "alta.html", rotulo: "Altas", icone: "↗", tipos: ["alta"] },
    { href: "relatorios.html", rotulo: "Relatórios", icone: "▥", tipos: [] },
    { href: "plantao.html", rotulo: "Plantões", icone: "◷", tipos: [] },
    { href: "ajuda.html", rotulo: "Ajuda", icone: "?", tipos: Object.keys(SETORES) },
    { href: "tv.html", rotulo: "Painel TV", icone: "▻", tipos: [], novaAba: true }
  ];

  // ---------- Sessão ----------

  function lerSessao() {
    try {
      const s = JSON.parse(sessionStorage.getItem(CHAVE_SESSAO));
      return s && s.token && s.tipo ? s : null;
    } catch {
      return null;
    }
  }

  function salvarSessao(sessao) {
    sessionStorage.setItem(CHAVE_SESSAO, JSON.stringify(sessao));
  }

  function sair() {
    sessionStorage.removeItem(CHAVE_SESSAO);
    location.href = "index.html";
  }

  // ---------- Requisições ----------

  // Igual ao fetch, mas envia o token de login. Se o servidor responder 401
  // (sessão vencida ou usuário removido), volta para a tela de login.
  async function requisitar(url, opcoes = {}) {
    const sessao = lerSessao();
    const headers = new Headers(opcoes.headers || {});

    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    if (sessao) headers.set("Authorization", "Bearer " + sessao.token);

    const resposta = await fetch(url, { ...opcoes, headers });

    if (resposta.status === 401 && sessao) {
      sessionStorage.removeItem(CHAVE_SESSAO);
      location.href = "index.html?sessao=expirada";
    }

    return resposta;
  }

  // Atalho: envia objeto como JSON e devolve o JSON da resposta (ou lança erro).
  async function api(url, { method = "GET", body } = {}) {
    const opcoes = { method };

    if (body !== undefined) {
      opcoes.headers = { "Content-Type": "application/json" };
      opcoes.body = JSON.stringify(body);
    }

    const resposta = await requisitar(url, opcoes);
    const conteudo = await resposta.text();
    let dados;

    try {
      dados = conteudo ? JSON.parse(conteudo) : {};
    } catch {
      throw new Error("Resposta inválida do servidor.");
    }

    if (!resposta.ok) throw new Error(dados.erro || "Operação não realizada.");
    return dados;
  }

  // ---------- Formatação ----------

  function dataHora(valor) {
    if (!valor) return "Horário não informado";
    const data = new Date(valor);
    if (Number.isNaN(data.getTime())) return "Horário não informado";
    return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(data);
  }

  function badgeRisco(risco) {
    const niveis = {
      verde: "Verde",
      amarelo: "Amarelo",
      vermelho: "Vermelho"
    };
    const nivel = typeof risco === "string" ? risco.toLowerCase() : "";
    const badge = criar("span", "risco-badge", niveis[nivel] || "Sem classificação");
    if (niveis[nivel]) badge.classList.add(`risco-${nivel}`);
    badge.setAttribute("aria-label", `Classificação de risco: ${niveis[nivel] || "não informada"}`);
    return badge;
  }

  function espera(valor, risco) {
    const data = new Date(valor);
    if (!valor || Number.isNaN(data.getTime())) {
      return { texto: "não informado", estourou: false };
    }

    const minutos = Math.max(0, Math.floor((Date.now() - data.getTime()) / 60000));
    const horas = Math.floor(minutos / 60);
    const restantes = minutos % 60;
    const textoEspera = horas
      ? `${horas} h ${restantes} min`
      : `${minutos} min`;
    const limites = { vermelho: 10, amarelo: 60, verde: 120 };
    const limite = limites[String(risco || "").toLowerCase()];

    return { texto: textoEspera, estourou: Boolean(limite && minutos > limite) };
  }

  function textoDuracao(valor) {
    if (valor === null || valor === undefined || valor === "") return "—";
    const minutos = Number(valor);
    if (!Number.isFinite(minutos) || minutos < 0) return "—";
    if (minutos < 60) return `${Math.round(minutos)} min`;

    const horas = Math.floor(minutos / 60);
    const restantes = Math.round(minutos % 60);
    return restantes ? `${horas} h ${restantes} min` : `${horas} h`;
  }

  // ---------- Navbar ----------

  function criar(tag, classe, conteudo) {
    const el = document.createElement(tag);
    if (classe) el.className = classe;
    if (conteudo !== undefined) el.textContent = conteudo;
    return el;
  }

  function montarNavbar(sessao) {
    const anterior = document.querySelector(".baymax-nav");
    if (anterior) anterior.remove();
    const botaoMenuAnterior = document.querySelector(".baymax-nav-toggle");
    if (botaoMenuAnterior) botaoMenuAnterior.remove();

    const paginaAtual = location.pathname.split("/").pop() || "index.html";
    const nav = criar("aside", "baymax-nav");
    nav.id = "baymax-sidebar";

    const marca = criar("a", "baymax-nav-brand");
    marca.href = PAGINA_INICIAL[sessao.tipo] || "index.html";
    marca.setAttribute("aria-label", "Baymax - página inicial");
    marca.title = "Página inicial";
    const logo = document.createElement("img");
    logo.src = "css/Captura de tela 2026-08-06 114854.png";
    logo.alt = "";
    logo.width = 32;
    logo.height = 32;
    marca.append(logo, criar("span", "", "Baymax"));

    const linhaMarca = criar("div", "baymax-nav-brand-row");
    controleTema.classList.remove("baymax-theme-toggle-floating");
    controleTema.classList.add("baymax-theme-toggle-icon-only");
    atualizarControleTema();
    linhaMarca.append(marca, controleTema);

    const botaoMenu = criar("button", "baymax-nav-toggle", "☰");
    botaoMenu.type = "button";
    botaoMenu.setAttribute("aria-label", "Abrir menu");
    botaoMenu.setAttribute("aria-expanded", "false");
    botaoMenu.setAttribute("aria-controls", "baymax-sidebar");

    const links = criar("nav", "baymax-nav-links");
    links.id = "baymax-nav-links";
    links.setAttribute("aria-label", "Módulos hospitalares");

    modulosVisiveis(sessao.tipo).forEach(item => {
      const a = criar("a", "baymax-nav-link");
      a.href = item.href;
      a.setAttribute("aria-label", item.rotulo);
      a.title = item.rotulo;
      a.append(criar("span", "baymax-nav-label", item.rotulo));

      if (item.novaAba) {
        a.target = "_blank";
        a.rel = "noopener";
      }

      if (item.href === paginaAtual) {
        a.classList.add("ativo");
        a.setAttribute("aria-current", "page");
      }

      links.appendChild(a);
    });

    botaoMenu.addEventListener("click", () => {
      const aberto = nav.classList.toggle("aberto");
      document.body.classList.toggle("nav-aberto", aberto);
      botaoMenu.textContent = aberto ? "×" : "☰";
      botaoMenu.setAttribute("aria-label", aberto ? "Fechar menu" : "Abrir menu");
      botaoMenu.setAttribute("aria-expanded", String(aberto));
    });

    const nome = sessao.nome || sessao.usuario;
    const usuario = criar("div", "baymax-nav-user");
    const fotoValida = typeof sessao.fotoPerfil === "string" &&
      /^data:image\/(jpeg|png|webp);base64,/.test(sessao.fotoPerfil);
    if (fotoValida) {
      const foto = document.createElement("img");
      foto.className = "baymax-nav-avatar baymax-nav-photo";
      foto.src = sessao.fotoPerfil;
      foto.alt = `Foto de perfil de ${nome}`;
      foto.width = 34;
      foto.height = 34;
      usuario.appendChild(foto);
    } else {
      usuario.appendChild(criar("span", "baymax-nav-avatar", nome.trim().charAt(0).toUpperCase() || "?"));
    }

    const identificacao = criar("div", "baymax-nav-id");
    identificacao.append(
      criar("strong", "", nome),
      criar("small", "", SETORES[sessao.tipo] || sessao.tipo)
    );
    usuario.appendChild(identificacao);

    const botaoSair = criar("button", "baymax-nav-logout");
    botaoSair.type = "button";
    botaoSair.setAttribute("aria-label", "Sair");
    botaoSair.title = "Sair";
    botaoSair.append(criar("span", "baymax-nav-label", "Sair"));
    botaoSair.addEventListener("click", sair);
    usuario.appendChild(botaoSair);

    nav.append(linhaMarca, links, usuario);
    document.body.classList.add("has-baymax-nav");
    document.body.prepend(nav, botaoMenu);
  }

  function modulosVisiveis(tipo) {
    return MENU
      .filter(item => tipo === "admin" || item.tipos.includes(tipo))
      .map(item => tipo === "admin" && item.href === "perfil.html"
        ? { ...item, rotulo: "Perfis de funcionários" }
        : item);
  }

  function atualizarControleTema(animar = false) {
    if (!controleTema) return;

    const proximo = temaAtual === "dark" ? "light" : "dark";
    const rotulo = `Ativar tema ${proximo === "dark" ? "escuro" : "claro"}`;
    const somenteIcone =
      controleTema.classList.contains("baymax-theme-toggle-floating") ||
      controleTema.classList.contains("baymax-theme-toggle-icon-only");
    const texto = somenteIcone ? "☾" : rotulo;
    const classe = somenteIcone ? "baymax-theme-icon" : "baymax-theme-label";
    const simbolo = criar("span", classe, texto);
    if (somenteIcone) simbolo.setAttribute("aria-hidden", "true");
    if (animar && somenteIcone) simbolo.classList.add("is-animating");
    controleTema.replaceChildren(simbolo);
    controleTema.setAttribute("aria-label", rotulo);
    controleTema.title = rotulo;
    controleTema.setAttribute("aria-pressed", String(temaAtual === "dark"));
  }

  function aplicarTema(tema, persistir = true) {
    temaAtual = tema === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = temaAtual;
    document.documentElement.style.colorScheme = temaAtual;

    const metaTema = document.querySelector('meta[name="theme-color"]');
    if (metaTema) metaTema.content = temaAtual === "dark" ? "#101a23" : "#087eac";

    if (persistir) {
      try {
        localStorage.setItem(CHAVE_TEMA, temaAtual);
      } catch (erro) {
        console.warn("Não foi possível salvar a preferência de tema:", erro);
      }
    }

    atualizarControleTema(persistir);
  }

  function prepararTema() {
    let temaSalvo = "light";
    try {
      temaSalvo = localStorage.getItem(CHAVE_TEMA) || "light";
    } catch (erro) {
      console.warn("Não foi possível ler a preferência de tema:", erro);
    }

    aplicarTema(temaSalvo, false);
    controleTema = criar("button", "baymax-theme-toggle baymax-theme-toggle-floating");
    controleTema.type = "button";
    controleTema.addEventListener("click", () => {
      aplicarTema(temaAtual === "dark" ? "light" : "dark");
    });
    document.body.appendChild(controleTema);
    aplicarTema(temaAtual, false);
  }

  // Atualiza a sessão guardada (ex.: administrador editou o próprio cadastro)
  function atualizarSessao(sessao) {
    salvarSessao(sessao);
    montarNavbar(sessao);
  }

  // Confere no servidor se o token ainda vale e se nome/setor mudaram
  async function validarSessao(sessao) {
    try {
      const resposta = await requisitar("/sessao");
      if (!resposta.ok) return;

      const atual = await resposta.json();

      if (atual.tipo !== sessao.tipo) {
        salvarSessao({ ...sessao, ...atual });
        location.href = PAGINA_INICIAL[atual.tipo] || "index.html";
      } else if (atual.nome !== sessao.nome || atual.fotoPerfil !== sessao.fotoPerfil) {
        atualizarSessao({ ...sessao, ...atual });
      }
    } catch {
      // sem conexão: mantém a sessão atual
    }
  }

  // Chame no início de cada tela. Retorna a sessão, ou null se o usuário
  // não pode ver esta tela (nesse caso ele já está sendo redirecionado).
  function iniciar(tiposPermitidos = []) {
    const sessao = lerSessao();

    if (!sessao) {
      location.href = "index.html";
      return null;
    }

    if (sessao.tipo !== "admin" && !tiposPermitidos.includes(sessao.tipo)) {
      location.href = PAGINA_INICIAL[sessao.tipo] || "index.html";
      return null;
    }

    montarNavbar(sessao);
    validarSessao(sessao);
    return sessao;
  }

  global.Baymax = {
    ESTOQUE_BAIXO,
    SETORES,
    fetch: requisitar,
    api,
    iniciar,
    sair,
    lerSessao,
    aplicarTema,
    atualizarSessao,
    dataHora,
    badgeRisco,
    espera,
    textoDuracao,
    modulosVisiveis
  };

  prepararTema();
})(window);