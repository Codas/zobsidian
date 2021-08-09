
import './markdown-it.min.js';


// create menu option on journal entry folder
let origGetFolderContextOptions = SidebarDirectory.prototype._getFolderContextOptions;
SidebarDirectory.prototype._getFolderContextOptions = function() {
  let opts = origGetFolderContextOptions();
  opts.push(
    {
      name: "Import Obsidian",
      icon: `<i class="fas fa-upload"></i>`,
      condition: header => {
	if ( !game.user.isGM ) {
	  return false;
	}
        const folder = game.folders.get(header.parent().data("folderId"));
	return folder.type === "JournalEntry";
      },
      callback: header => {
        const li = header.parent();
        const folder = game.folders.get( li.data("folderId") );
	importMarkdown( folder );
      }
    });
  return opts;
}


class importMarkdownForm extends FormApplication {
  constructor( folder ) {
    super();
    this.folder = folder;
    this.dataFolder = null;
    this.renderChildren = [];
    this.rootDir = null;

    this.markDown = markdownit();
    this.defaultRenderText = this.markDown.renderer.rules.text;

    // overload rule for text processing by markdown-it
    this.markDown.renderer.rules.text = function( tokens, idx, options, env, self )
    {
      let token = tokens[idx];
      let matches = token.content.match( /\[\[[^\]]+\]\]/g );
      if ( matches ) {
	let topLevel = (idx==0 && tokens.length==1 && token.content.charAt(0)=='[' ) ? 1 : 0;
	let html = token.content;
	for ( let link of matches ) {
	  let name = link.replace( /(\[|\])/g, "" );
	  let title = null;
	  let t = name.match( /^(.*)\|(.*)$/ );
	  if ( t ) {
	    name = t[1];
	    title = t[2];
	  } else {
	    title = name.match( /([^\/]+)$/ )[1];
	  }
	  env.renderChildren.push( { name: name, title: title } );
	  return `<span class="zlink">@JournalEntry[zid=${name}]{${title}}</span>`;
	}
	return html;
      }
      return env.defaultRenderText( tokens, idx, options, env, self );
    }
  }

  static get defaultOptions() {
    let obj = mergeObject( super.defaultOptions, {
      closeOnSubmit: true,
      submitOnChange: false,
      submitOnClose: false,
      width: 300,
      template: "modules/zobsidian/dialog.html",
      title: "Import Obsidian",
      id: "import-obsidian"
    });
    return obj;
  }

  async addTOC( myDBs, toc, data, level ) {
    let margin = 20 * level;
    toc.content += `<div style="margin-left: ${margin}px">@JournalEntry[${data.journal.id}]{${data.journal.name}}</div>`
    for ( let child of data.db.children ) {
      let childData = myDBs[ child.name ];
      await this.addTOC( myDBs, toc, childData, level+1 );
    }
  }

  async createTOC( myDBs, root ) {
    let toc = {
      name: "Table of Contents",
      folder: this.folder.id,
      content: ""
    };
    await this.addTOC( myDBs, toc, root, 0 );

    let journal = await this.folder.contents.find( e => e.name === toc.name );
    if ( journal ) {
      journal = await journal.update( toc );
    } else {
      journal = await JournalEntry.create( toc );
    }
  }

  // read markdown file
  async readMarkdown( filename, myDBs, level ) {
    // determine the full path from the rootDir
    // expected that all links are directories below the rootDir
    let fullFileName = filename;
    let firstDirMatch = filename.match( /^[^\/]+/ );
    if ( firstDirMatch && firstDirMatch.length > 0 ) {
      let path = this.rootDir.split( firstDirMatch[0] )[0];
      fullFileName = `${path}${filename}`;
    }
    console.log( `Reading markdown ${fullFileName}` );

    const response = await fetch( fullFileName );
    if ( !response.ok ) {
      ui.notifications.error( `Error reading ${fullFileName}` );
      return;
    }
    let data = await response.text();

    let basename = filename.replace( /\.md$/, "" );
    let name = basename.match( /([^\/]+)$/ )[1];
    let myFolder = (level>0) ? this.dataFolder : this.folder;
    let db = {};
    db.name = name;
    db.folder = myFolder.id;

    this.renderChildren = [];
    let html = await this.markDown.render( data, { renderChildren: this.renderChildren, defaultRenderText: this.defaultRenderText } );
    db.content = html;
    db.children = [];
    for ( let child of this.renderChildren ) {
      if ( myDBs[ child.name ] === undefined ) {
	db.children.push( { name: child.name, title: child.title } );
      }
    }
    this.renderChildren = [];

    // search folder for existing name
    let journal = await myFolder.contents.find( e => e.name === db.name );
    if ( journal ) {
      journal = await journal.update( db );
    } else {
      journal = await JournalEntry.create( db );
    }
    let link = { journal: journal, db: db };
    myDBs[ basename ] = link;

    // process children
    for ( let child of db.children ) {
      await this.readMarkdown( `${child.name}.md`, myDBs, level+1 );
    }

    return link;
  }

  // walk back through created journals and update links
  async updateLinks( myDBs )
  {
    for ( let name of Object.keys( myDBs ) ) {
      let journal = myDBs[name].journal;
      let html = $(`<div></div>`);
      html.html( journal.data.content );

      let links = html.find( '[class^="zlink"]' );
      for ( let i = 0; i < links.length; i++ ) {
	let value = links[i].innerHTML;
	let matches = value.match( /\[zid=([^\]]+)\]/ );
	if ( matches ) {
	  let link = myDBs[ matches[1] ].journal;
	  if ( link ) {
	    let swap = `zid=${matches[1]}`;
	    links[i].innerHTML = value.replace( swap, `${link.id}` );
	  }
	}
      }

      if ( links.length > 0 ) {
	let db = {
	  content: html.html()
	};
	await journal.update( db );
      }
    }
  }

  async _updateObject( event, formData ) {
    if ( event.submitter.value != "submit" ) {
      return;
    }
    let filename = formData.mdfile;
    if ( filename == "" ) {
      return;
    }

    this.dataFolder = null;
    for ( let f of this.folder.children ) {
      if ( f.name === 'data' ) {
	this.dataFolder = f;
      }
    }
    if ( this.dataFolder === null ) {
      this.dataFolder = await Folder.create( {
	parent: this.folder.id,
	type: 'JournalEntry',
	name: 'data' } );
    }

    let myDBs = {};
    this.rootDir = filename.replace( /[^\/]+$/, "" );
    let rootDB = await this.readMarkdown( filename, myDBs, 0 );
    await this.updateLinks( myDBs );
    await this.createTOC( myDBs, rootDB );
  }
};
			   
async function importMarkdown( folder )
{
  await new importMarkdownForm( folder ).render( true );
}
